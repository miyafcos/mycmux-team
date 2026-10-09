//! Watches a staging directory until an isolated CLI login finishes.
//!
//! The CLI does not tell us when the browser round-trip completed - it just
//! writes identity and credentials. Files are polled on all platforms; Claude
//! on macOS also needs one keychain read per tick once identity appears. A
//! one-second poll is well inside human reaction time, and avoids taking on a
//! filesystem-notification dependency whose Windows directory watch races the
//! directory we just created.
//!
//! The watcher never touches live credentials, so it deliberately does *not*
//! hold the mutation lock while polling - only `capture_staged` takes it, for
//! as long as the registry write needs. `live_sync` uses `try_mutation_guard`
//! and must keep being able to skip a tick rather than block behind us.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::{
    claude, codex, grok, live_sync::FileStamps, staging, CliAccountProfile, CliProvider,
    ERR_CODEX_LOGIN_FILE_MISSING, ERR_LOGIN_CANCELLED, ERR_LOGIN_TIMEOUT,
};

/// Contract shared with the frontend. Renaming any of these breaks the UI.
pub const EVENT_LOGIN_COMPLETED: &str = "mycmux://cli-login-completed";
pub const EVENT_LOGIN_FAILED: &str = "mycmux://cli-login-failed";
pub const EVENT_LOGIN_IDENTITY_MISMATCH: &str = "mycmux://cli-login-identity-mismatch";

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginMode {
    New,
    Reauth { expected_identity_key: String },
}

impl LoginMode {
    fn expected_identity(&self) -> Option<&str> {
        match self {
            LoginMode::New => None,
            LoginMode::Reauth {
                expected_identity_key,
            } => Some(expected_identity_key.as_str()),
        }
    }

    fn wire_name(&self) -> &'static str {
        match self {
            LoginMode::New => "new",
            LoginMode::Reauth { .. } => "reauth",
        }
    }
}

/// What the frontend asks for. Kept separate from `LoginMode` so the command
/// surface takes an id and the watcher takes the resolved identity.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum CliLoginMode {
    New,
    Reauth,
}

pub struct PendingLogin {
    pub login_id: String,
    pub provider: CliProvider,
    pub dir: PathBuf,
    pub mode: LoginMode,
    pub started_at: Instant,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
pub struct CliLoginSessionStatus {
    pub login_id: String,
    pub provider: CliProvider,
    pub mode: String,
    pub staging_dir: String,
    pub elapsed_secs: u64,
}

#[derive(Serialize, Clone)]
pub struct LoginCompletedPayload {
    pub login_id: String,
    pub profile: CliAccountProfile,
    pub updated_existing: bool,
}

#[derive(Serialize, Clone)]
pub struct LoginFailedPayload {
    pub login_id: String,
    pub code: String,
}

#[derive(Serialize, Clone)]
pub struct LoginIdentityMismatchPayload {
    pub login_id: String,
    pub email: Option<String>,
}

/// Tauri managed state: at most one in-flight login per provider.
#[derive(Default)]
pub struct LoginRegistry(Mutex<HashMap<String, PendingLogin>>);

impl LoginRegistry {
    /// A poisoned lock here means a previous holder panicked while editing a
    /// plain map. Recovering is strictly better than refusing every future
    /// login for the lifetime of the process.
    fn guard(&self) -> MutexGuard<'_, HashMap<String, PendingLogin>> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Claim the provider slot. Returns false when a login is already running
    /// for that provider; checking and inserting under one lock is what makes
    /// two rapid clicks produce one staging directory instead of two.
    pub fn try_insert(&self, pending: PendingLogin) -> bool {
        let mut sessions = self.guard();
        if sessions
            .values()
            .any(|existing| existing.provider == pending.provider)
        {
            return false;
        }
        sessions.insert(pending.login_id.clone(), pending);
        true
    }

    pub fn remove(&self, login_id: &str) {
        self.guard().remove(login_id);
    }

    /// Ask the watcher to stop. It reacts on its next tick, cleans the staging
    /// directory up and removes itself from this registry.
    pub fn request_cancel(&self, login_id: &str) -> bool {
        match self.guard().get(login_id) {
            Some(pending) => {
                pending.cancel.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn list(&self) -> Vec<CliLoginSessionStatus> {
        let mut sessions: Vec<_> = self
            .guard()
            .values()
            .map(|pending| CliLoginSessionStatus {
                login_id: pending.login_id.clone(),
                provider: pending.provider,
                mode: pending.mode.wire_name().to_string(),
                staging_dir: pending.dir.display().to_string(),
                elapsed_secs: pending.started_at.elapsed().as_secs(),
            })
            .collect();
        sessions.sort_by(|left, right| left.login_id.cmp(&right.login_id));
        sessions
    }
}

/// Per-watcher bookkeeping carried across ticks.
#[derive(Default)]
pub struct WatchState {
    stamps: FileStamps,
    /// Identity and credential size seen last tick. A capture only happens when
    /// the next tick agrees with it.
    candidate: Option<(String, u64)>,
    /// The CLI wrote identity before tokens. Keychain writes have no file
    /// stamp, so keep reading every tick until tokens arrive or identity goes.
    awaiting_credentials: Option<String>,
}

impl WatchState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TickOutcome {
    /// Nothing usable yet, or waiting for the credentials to settle.
    Idle,
    /// A login landed, but for a different account than the reauth target.
    /// Reported once and then ignored: the user can log in again with the right
    /// account without restarting the flow.
    Mismatch {
        email: Option<String>,
        identity_key: String,
    },
    /// Credentials look complete and stable. Capture now.
    Ready,
}

fn watched_paths(
    provider: CliProvider,
    dir: &Path,
    claude_paths: &claude::ClaudePaths,
) -> Vec<PathBuf> {
    match provider {
        CliProvider::Claude => match &claude_paths.store {
            claude::CredentialStore::File => vec![
                claude_paths.credentials.clone(),
                claude_paths.claude_json.clone(),
            ],
            claude::CredentialStore::Keychain { .. } => vec![claude_paths.claude_json.clone()],
        },
        CliProvider::Codex => vec![staging::codex_staging_paths(dir).auth],
        CliProvider::Grok => vec![staging::grok_staging_paths(dir).auth],
    }
}

/// Byte length of the token store, reusing the Claude read from this tick.
/// An absent or empty store must never look like settled credentials.
fn credentials_len(
    provider: CliProvider,
    dir: &Path,
    claude_credentials: &mut claude::CredentialsOnce<'_>,
) -> Option<u64> {
    let path = match provider {
        CliProvider::Claude => {
            let len = claude_credentials.text()?.len() as u64;
            return (len > 0).then_some(len);
        }
        CliProvider::Codex => staging::codex_staging_paths(dir).auth,
        CliProvider::Grok => staging::grok_staging_paths(dir).auth,
    };
    let len = std::fs::metadata(path).ok()?.len();
    (len > 0).then_some(len)
}

/// One poll of the staging directory and its scoped credential store.
///
/// The mtime gate is skipped while a candidate is pending: a CLI writes the
/// credential file once, so the confirming observation happens on a tick where
/// nothing moved. Also skip it while identity is waiting for credentials: a
/// later keychain write cannot advance a file stamp.
pub fn poll_once(
    dir: &Path,
    provider: CliProvider,
    mode: &LoginMode,
    state: &mut WatchState,
) -> TickOutcome {
    poll_once_with_credentials(dir, provider, mode, state, &staging::NativeCredentials)
}

fn poll_once_with_credentials(
    dir: &Path,
    provider: CliProvider,
    mode: &LoginMode,
    state: &mut WatchState,
    credentials: &dyn staging::StagingCredentials,
) -> TickOutcome {
    let claude_paths = credentials.claude_paths(dir);
    let watched = watched_paths(provider, dir, &claude_paths);
    let watched_refs: Vec<&Path> = watched.iter().map(PathBuf::as_path).collect();
    let moved = state.stamps.changed(&watched_refs);
    if !moved && state.candidate.is_none() && state.awaiting_credentials.is_none() {
        return TickOutcome::Idle;
    }

    let reader = |paths: &claude::ClaudePaths| credentials.read(paths);
    let mut claude_credentials = claude::CredentialsOnce::with_reader(&claude_paths, &reader);
    let live = match provider {
        CliProvider::Claude => {
            claude::read_live_identity_reusing(&claude_paths, &mut claude_credentials)
        }
        CliProvider::Codex => codex::read_live_identity(&staging::codex_staging_paths(dir)),
        CliProvider::Grok => grok::read_live_identity(&staging::grok_staging_paths(dir)),
    };
    let Some(identity) = live.identity_key else {
        state.candidate = None;
        state.awaiting_credentials = None;
        return TickOutcome::Idle;
    };
    if provider == CliProvider::Grok && live.email.is_none() {
        state.candidate = None;
        state.awaiting_credentials = None;
        return TickOutcome::Idle;
    }
    if mode
        .expected_identity()
        .is_some_and(|expected| expected != identity)
    {
        state.candidate = None;
        state.awaiting_credentials = None;
        return TickOutcome::Mismatch {
            email: live.email,
            identity_key: identity,
        };
    }
    let Some(len) = credentials_len(provider, dir, &mut claude_credentials) else {
        state.candidate = None;
        state.awaiting_credentials = Some(identity);
        return TickOutcome::Idle;
    };
    state.awaiting_credentials = None;

    match state.candidate.replace((identity.clone(), len)) {
        Some((previous_identity, previous_len))
            if previous_identity == identity && previous_len == len =>
        {
            TickOutcome::Ready
        }
        _ => TickOutcome::Idle,
    }
}

/// Why the watcher should stop before the login completes, if it should.
fn terminal_reason(cancelled: bool, elapsed: Duration) -> Option<&'static str> {
    if cancelled {
        return Some(ERR_LOGIN_CANCELLED);
    }
    if elapsed >= LOGIN_TIMEOUT {
        return Some(ERR_LOGIN_TIMEOUT);
    }
    None
}

fn cleanup_if_terminal(
    dir: &Path,
    cancelled: bool,
    elapsed: Duration,
    credentials: &dyn staging::StagingCredentials,
) -> Option<&'static str> {
    let code = terminal_reason(cancelled, elapsed)?;
    staging::cleanup_staging_with_credentials(dir, credentials);
    Some(code)
}

pub(super) fn cleanup_login_if_terminal(
    dir: &Path,
    provider: CliProvider,
    cancelled: bool,
    elapsed: Duration,
    credentials: &dyn staging::StagingCredentials,
) -> Option<&'static str> {
    // Check before cleanup removes the evidence. Cancellation keeps its code.
    let missing_codex_auth = provider == CliProvider::Codex
        && !staging::codex_staging_paths(dir).auth.is_file();
    let code = cleanup_if_terminal(dir, cancelled, elapsed, credentials)?;
    Some(if code == ERR_LOGIN_TIMEOUT && missing_codex_auth {
        ERR_CODEX_LOGIN_FILE_MISSING
    } else {
        code
    })
}

/// Everything one watcher needs. Mirrors the registry entry rather than
/// borrowing it, so the poll loop never holds the registry lock.
pub struct LoginWatch {
    pub login_id: String,
    pub provider: CliProvider,
    pub dir: PathBuf,
    pub mode: LoginMode,
    pub label: Option<String>,
    pub cancel: Arc<AtomicBool>,
}

/// Frees the provider slot however the watcher ends - including a dropped or
/// panicking task. A leaked entry would refuse every later login for that
/// provider until the app restarts, which is far worse than the leak itself.
struct RegistrySlot {
    app: AppHandle,
    login_id: String,
}

impl Drop for RegistrySlot {
    fn drop(&mut self) {
        // `try_state` rather than `state`: during shutdown the managed state
        // may already be gone, and panicking in a Drop that runs while
        // unwinding aborts the process.
        if let Some(registry) = self.app.try_state::<LoginRegistry>() {
            registry.remove(&self.login_id);
        }
    }
}

pub fn spawn(app: AppHandle, base: PathBuf, watch: LoginWatch) {
    tauri::async_runtime::spawn(async move {
        let _slot = RegistrySlot {
            app: app.clone(),
            login_id: watch.login_id.clone(),
        };
        run(&app, &base, &watch).await;
    });
}

async fn run(app: &AppHandle, base: &Path, watch: &LoginWatch) {
    let mut state = WatchState::new();
    let started = Instant::now();
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;

        if let Some(code) = cleanup_login_if_terminal(
            &watch.dir,
            watch.provider,
            watch.cancel.load(Ordering::SeqCst),
            started.elapsed(),
            &staging::NativeCredentials,
        ) {
            emit_failed(app, &watch.login_id, code);
            return;
        }

        let dir = watch.dir.clone();
        let provider = watch.provider;
        let mode = watch.mode.clone();
        let polled = tauri::async_runtime::spawn_blocking(move || {
            let outcome = poll_once(&dir, provider, &mode, &mut state);
            (outcome, state)
        })
        .await;
        let outcome = match polled {
            Ok((outcome, returned)) => {
                state = returned;
                outcome
            }
            Err(error) => {
                crate::diag_warn!("cli_accounts", "login watcher poll failed: {error}");
                staging::cleanup_staging(&watch.dir);
                emit_failed(app, &watch.login_id, ERR_LOGIN_TIMEOUT);
                return;
            }
        };

        match outcome {
            TickOutcome::Idle => continue,
            TickOutcome::Mismatch { email, .. } => {
                let _ = app.emit(
                    EVENT_LOGIN_IDENTITY_MISMATCH,
                    LoginIdentityMismatchPayload {
                        login_id: watch.login_id.clone(),
                        email,
                    },
                );
                continue;
            }
            TickOutcome::Ready => {
                if watch.provider == CliProvider::Claude {
                    let paths = staging::claude_staging_paths(&watch.dir);
                    if let Some(token) = claude::read_credentials(&paths)
                        .and_then(|text| super::token_owner::claude_access_token(&text)) {
                        let state = app.state::<crate::usage::UsageState>();
                        let _ = tokio::time::timeout(Duration::from_secs(6),
                            super::token_owner::claude_token_owner(&state.http, &token)).await;
                    }
                }
                let base = base.to_path_buf();
                let dir = watch.dir.clone();
                let provider = watch.provider;
                let label = watch.label.clone();
                let expected = watch
                    .mode
                    .expected_identity()
                    .map(std::string::ToString::to_string);
                let captured = tauri::async_runtime::spawn_blocking(move || {
                    staging::capture_staged(&base, provider, &dir, label, expected.as_deref())
                })
                .await;
                match captured {
                    Ok(Ok((profile, updated_existing))) => {
                        let _ = app.emit(
                            EVENT_LOGIN_COMPLETED,
                            LoginCompletedPayload {
                                login_id: watch.login_id.clone(),
                                profile,
                                updated_existing,
                            },
                        );
                    }
                    Ok(Err(code)) => emit_failed(app, &watch.login_id, &code),
                    Err(error) => {
                        crate::diag_warn!("cli_accounts", "login capture failed to run: {error}");
                        emit_failed(app, &watch.login_id, ERR_LOGIN_TIMEOUT);
                    }
                }
                staging::cleanup_staging(&watch.dir);
                return;
            }
        }
    }
}

fn emit_failed(app: &AppHandle, login_id: &str, code: &str) {
    let _ = app.emit(
        EVENT_LOGIN_FAILED,
        LoginFailedPayload {
            login_id: login_id.to_string(),
            code: code.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use staging::test_support::{FakeKeychain, FileCredentials};
    use std::fs;
    use tempfile::tempdir;

    const CLAUDE_JSON: &str = include_str!("fixtures/claude_json_sample.json");
    const CREDS: &str = include_str!("fixtures/claude_credentials_sample.json");
    const CODEX: &str = include_str!("fixtures/codex_auth_sample.json");

    #[test]
    fn codex_missing_auth_timeout_explains_storage_and_cleans_staging() {
        let base = tempdir().unwrap();
        let dir = staging::create_staging_dir(base.path()).unwrap();
        assert_eq!(cleanup_login_if_terminal(&dir, CliProvider::Codex, false,
            LOGIN_TIMEOUT - Duration::from_secs(1), &FileCredentials), None);
        assert!(dir.exists());
        assert_eq!(cleanup_login_if_terminal(&dir, CliProvider::Codex, false,
            LOGIN_TIMEOUT, &FileCredentials), Some(ERR_CODEX_LOGIN_FILE_MISSING));
        assert!(!dir.exists());
    }

    #[test]
    fn codex_auth_present_keeps_the_general_timeout_code() {
        let base = tempdir().unwrap();
        let dir = staging::create_staging_dir(base.path()).unwrap();
        fs::write(dir.join("auth.json"), "incomplete").unwrap();
        assert_eq!(cleanup_login_if_terminal(&dir, CliProvider::Codex, false,
            LOGIN_TIMEOUT, &FileCredentials), Some(ERR_LOGIN_TIMEOUT));
        assert!(!dir.exists());
    }

    #[test]
    fn cancelling_codex_without_auth_keeps_the_cancellation_code() {
        let base = tempdir().unwrap();
        let dir = staging::create_staging_dir(base.path()).unwrap();
        assert_eq!(cleanup_login_if_terminal(&dir, CliProvider::Codex, true,
            LOGIN_TIMEOUT, &FileCredentials), Some(ERR_LOGIN_CANCELLED));
        assert!(!dir.exists());
    }

    // Run the original file-based assertions on every host without consulting
    // the real macOS keychain.
    fn poll_once(
        dir: &Path,
        provider: CliProvider,
        mode: &LoginMode,
        state: &mut WatchState,
    ) -> TickOutcome {
        super::poll_once_with_credentials(dir, provider, mode, state, &FileCredentials)
    }

    fn keychain_poll(dir: &Path, state: &mut WatchState, keychain: &FakeKeychain) -> TickOutcome {
        super::poll_once_with_credentials(dir, CliProvider::Claude, &LoginMode::New, state, keychain)
    }

    #[test]
    fn keychain_login_settles_captures_and_removes_only_its_staging_service() {
        let base = tempdir().unwrap();
        let dir = staging::create_staging_dir(base.path()).unwrap();
        let service = FakeKeychain::service(&dir);
        let keychain = FakeKeychain::default();
        keychain.insert(&service, CREDS);
        keychain.insert("Claude Code-credentials", "live credentials");
        keychain.insert("Claude Code", "other live item");
        keychain.insert("Claude Code-credentials-16a22eae", "old orphan");
        fs::write(dir.join(".claude.json"), CLAUDE_JSON).unwrap();
        assert!(!dir.join(".credentials.json").exists());

        let mut state = WatchState::new();
        assert_eq!(keychain_poll(&dir, &mut state, &keychain), TickOutcome::Idle);
        assert_eq!(keychain_poll(&dir, &mut state, &keychain), TickOutcome::Ready);
        let (profile, updated) = staging::capture_staged_with_credentials(
            base.path(), CliProvider::Claude, &dir, None, Some("claude-account-a"), &keychain,
        ).unwrap();
        assert!(!updated);
        assert_eq!(profile.identity_key, "claude-account-a");
        assert_eq!(profile.email.as_deref(), Some("a@example.test"));
        let super::super::snapshot::StoredSnapshot::Claude(stored) =
            super::super::snapshot::load(base.path(), &profile.id).unwrap() else {
                panic!("expected Claude snapshot");
            };
        assert_eq!(stored.credentials_text, CREDS);
        assert_eq!(super::super::registry::load(base.path()).unwrap().profiles[0].id, profile.id);
        assert_eq!(keychain.reads(), vec![service.clone(); 3], "one read per tick, one per capture");

        staging::cleanup_staging_with_credentials(&dir, &keychain);
        assert!(!dir.exists());
        assert!(!keychain.contains(&service));
        assert_eq!(keychain.removed(), vec![service]);
        assert!(keychain.contains("Claude Code-credentials"));
        assert!(keychain.contains("Claude Code"));
        assert!(keychain.contains("Claude Code-credentials-16a22eae"));
    }

    #[test]
    fn keychain_credentials_arriving_after_identity_settle_without_a_file_change() {
        let dir = tempdir().unwrap();
        let keychain = FakeKeychain::default();
        let service = FakeKeychain::service(dir.path());
        let mut state = WatchState::new();
        fs::write(dir.path().join(".claude.json"), CLAUDE_JSON).unwrap();

        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        assert_eq!(state.awaiting_credentials.as_deref(), Some("claude-account-a"));
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        keychain.insert(&service, CREDS);
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        assert!(state.awaiting_credentials.is_none());
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Ready);
        assert_eq!(keychain.reads(), vec![service; 4]);
        assert!(!dir.path().join(".credentials.json").exists());
    }

    #[test]
    fn a_growing_keychain_credential_restarts_the_two_tick_settle_window() {
        let dir = tempdir().unwrap();
        let keychain = FakeKeychain::default();
        let service = FakeKeychain::service(dir.path());
        let mut state = WatchState::new();
        fs::write(dir.path().join(".claude.json"), CLAUDE_JSON).unwrap();
        keychain.insert(&service, &CREDS[..20]);
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        keychain.insert(&service, CREDS);
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Ready);
        assert_eq!(keychain.reads(), vec![service; 3]);
    }

    #[test]
    fn a_timed_out_keychain_login_deletes_its_service_and_staging_directory() {
        let base = tempdir().unwrap();
        let dir = staging::create_staging_dir(base.path()).unwrap();
        let keychain = FakeKeychain::default();
        let service = FakeKeychain::service(&dir);
        keychain.insert(&service, CREDS);

        assert_eq!(cleanup_if_terminal(&dir, false, LOGIN_TIMEOUT - POLL_INTERVAL, &keychain), None);
        assert!(dir.is_dir());
        assert!(keychain.contains(&service));
        assert_eq!(cleanup_if_terminal(&dir, false, LOGIN_TIMEOUT, &keychain), Some(ERR_LOGIN_TIMEOUT));
        assert!(!dir.exists());
        assert!(!keychain.contains(&service));
        assert_eq!(keychain.removed(), vec![service]);
        assert!(keychain.reads().is_empty());
        assert!(super::super::registry::load(base.path()).unwrap().profiles.is_empty());
    }

    #[test]
    fn a_cancelled_keychain_login_deletes_its_service_without_registering_an_account() {
        let base = tempdir().unwrap();
        let dir = staging::create_staging_dir(base.path()).unwrap();
        let keychain = FakeKeychain::default();
        let service = FakeKeychain::service(&dir);
        keychain.insert(&service, CREDS);
        let cancel = Arc::new(AtomicBool::new(false));
        let registry = LoginRegistry::default();
        assert!(registry.try_insert(PendingLogin {
            dir: dir.clone(), cancel: cancel.clone(), ..pending("keychain-cancel", CliProvider::Claude)
        }));
        assert!(registry.request_cancel("keychain-cancel"));

        assert_eq!(cleanup_if_terminal(&dir, cancel.load(Ordering::SeqCst), LOGIN_TIMEOUT, &keychain), Some(ERR_LOGIN_CANCELLED));
        assert!(!dir.exists());
        assert!(!keychain.contains(&service));
        assert_eq!(keychain.removed(), vec![service]);
        assert!(super::super::registry::load(base.path()).unwrap().profiles.is_empty());
    }

    #[test]
    fn file_backed_login_still_settles_captures_and_cleans_up() {
        let base = tempdir().unwrap();
        let dir = staging::create_staging_dir(base.path()).unwrap();
        staged_claude(&dir, CLAUDE_JSON);
        let mut state = WatchState::new();
        assert_eq!(poll_once(&dir, CliProvider::Claude, &LoginMode::New, &mut state), TickOutcome::Idle);
        assert_eq!(poll_once(&dir, CliProvider::Claude, &LoginMode::New, &mut state), TickOutcome::Ready);
        let (profile, _) = staging::capture_staged_with_credentials(
            base.path(), CliProvider::Claude, &dir, None, None, &FileCredentials,
        ).unwrap();
        assert_eq!(profile.identity_key, "claude-account-a");
        staging::cleanup_staging_with_credentials(&dir, &FileCredentials);
        assert!(!dir.exists());
    }

    #[test]
    fn keychain_mismatch_is_reported_once_until_identity_changes() {
        let dir = tempdir().unwrap();
        let keychain = FakeKeychain::default();
        let service = FakeKeychain::service(dir.path());
        let mode = LoginMode::Reauth { expected_identity_key: "claude-account-b".into() };
        let mut state = WatchState::new();
        keychain.insert(&service, CREDS);
        write_stamped(dir.path().join(".claude.json"), CLAUDE_JSON);

        assert!(matches!(super::poll_once_with_credentials(dir.path(), CliProvider::Claude, &mode, &mut state, &keychain), TickOutcome::Mismatch { .. }));
        for _ in 0..3 {
            assert_eq!(super::poll_once_with_credentials(dir.path(), CliProvider::Claude, &mode, &mut state, &keychain), TickOutcome::Idle);
        }
        assert_eq!(keychain.reads().len(), 1);
        write_stamped(dir.path().join(".claude.json"), &CLAUDE_JSON.replace("claude-account-a", "claude-account-b"));
        assert_eq!(super::poll_once_with_credentials(dir.path(), CliProvider::Claude, &mode, &mut state, &keychain), TickOutcome::Idle);
        assert_eq!(super::poll_once_with_credentials(dir.path(), CliProvider::Claude, &mode, &mut state, &keychain), TickOutcome::Ready);
    }

    #[test]
    fn losing_identity_stops_keychain_reads_until_identity_returns() {
        let dir = tempdir().unwrap();
        let keychain = FakeKeychain::default();
        let service = FakeKeychain::service(dir.path());
        let mut state = WatchState::new();
        write_stamped(dir.path().join(".claude.json"), CLAUDE_JSON);
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        fs::remove_file(dir.path().join(".claude.json")).unwrap();
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        assert!(state.awaiting_credentials.is_none());
        keychain.insert(&service, CREDS);
        for _ in 0..3 {
            assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        }
        assert_eq!(keychain.reads(), vec![service.clone()]);
        write_stamped(dir.path().join(".claude.json"), CLAUDE_JSON);
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Ready);
        assert_eq!(keychain.reads(), vec![service; 3]);
    }

    #[test]
    fn an_empty_or_seeded_staging_config_does_not_read_keychain_credentials() {
        let dir = tempdir().unwrap();
        let keychain = FakeKeychain::default();
        let mut state = WatchState::new();
        assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        write_stamped(dir.path().join(".claude.json"), r#"{"theme":"dark"}"#);
        for _ in 0..3 {
            assert_eq!(keychain_poll(dir.path(), &mut state, &keychain), TickOutcome::Idle);
        }
        assert!(keychain.reads().is_empty());
    }

    /// Windows advances file timestamps on the ~15ms system tick, so writes a
    /// test performs microseconds apart can land on the same mtime. Stamping
    /// each write forward keeps "the user logged in again" observable no matter
    /// how fast the machine running the test is.
    fn write_stamped(path: PathBuf, contents: &str) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static TICK: AtomicU64 = AtomicU64::new(0);

        fs::write(&path, contents).unwrap();
        let seconds = 1_700_000_000 + TICK.fetch_add(1, Ordering::Relaxed);
        let stamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(stamp))
            .unwrap();
    }

    fn staged_claude(dir: &Path, claude_json: &str) {
        write_stamped(dir.join(".claude.json"), claude_json);
        write_stamped(dir.join(".credentials.json"), CREDS);
    }

    #[test]
    fn event_names_match_the_frontend_contract() {
        assert_eq!(EVENT_LOGIN_COMPLETED, "mycmux://cli-login-completed");
        assert_eq!(EVENT_LOGIN_FAILED, "mycmux://cli-login-failed");
        assert_eq!(
            EVENT_LOGIN_IDENTITY_MISMATCH,
            "mycmux://cli-login-identity-mismatch"
        );
    }

    #[test]
    fn an_empty_staging_dir_stays_idle() {
        let dir = tempdir().unwrap();
        let mut state = WatchState::new();
        for _ in 0..3 {
            assert_eq!(
                poll_once(dir.path(), CliProvider::Claude, &LoginMode::New, &mut state),
                TickOutcome::Idle
            );
        }
    }

    #[test]
    fn a_finished_login_becomes_ready_only_after_two_agreeing_ticks() {
        let dir = tempdir().unwrap();
        let mut state = WatchState::new();
        assert_eq!(
            poll_once(dir.path(), CliProvider::Claude, &LoginMode::New, &mut state),
            TickOutcome::Idle
        );

        staged_claude(dir.path(), CLAUDE_JSON);
        assert_eq!(
            poll_once(dir.path(), CliProvider::Claude, &LoginMode::New, &mut state),
            TickOutcome::Idle,
            "the first sighting must not capture a possibly half-written file"
        );
        assert_eq!(
            poll_once(dir.path(), CliProvider::Claude, &LoginMode::New, &mut state),
            TickOutcome::Ready
        );
    }

    #[test]
    fn a_growing_credential_file_is_not_settled() {
        let dir = tempdir().unwrap();
        let mut state = WatchState::new();
        fs::write(dir.path().join(".claude.json"), CLAUDE_JSON).unwrap();
        fs::write(dir.path().join(".credentials.json"), &CREDS[..20]).unwrap();
        assert_eq!(
            poll_once(dir.path(), CliProvider::Claude, &LoginMode::New, &mut state),
            TickOutcome::Idle
        );

        fs::write(dir.path().join(".credentials.json"), CREDS).unwrap();
        assert_eq!(
            poll_once(dir.path(), CliProvider::Claude, &LoginMode::New, &mut state),
            TickOutcome::Idle,
            "a changed size restarts the settle window"
        );
        assert_eq!(
            poll_once(dir.path(), CliProvider::Claude, &LoginMode::New, &mut state),
            TickOutcome::Ready
        );
    }

    #[test]
    fn an_identity_without_credentials_never_settles() {
        let dir = tempdir().unwrap();
        let mut state = WatchState::new();
        fs::write(dir.path().join(".claude.json"), CLAUDE_JSON).unwrap();
        for _ in 0..3 {
            assert_eq!(
                poll_once(dir.path(), CliProvider::Claude, &LoginMode::New, &mut state),
                TickOutcome::Idle
            );
        }
    }

    #[test]
    fn reauth_reports_a_wrong_account_and_never_captures_it() {
        let dir = tempdir().unwrap();
        let mode = LoginMode::Reauth {
            expected_identity_key: "claude-account-b".into(),
        };
        let mut state = WatchState::new();
        staged_claude(dir.path(), CLAUDE_JSON);

        assert_eq!(
            poll_once(dir.path(), CliProvider::Claude, &mode, &mut state),
            TickOutcome::Mismatch {
                email: Some("a@example.test".into()),
                identity_key: "claude-account-a".into(),
            }
        );
        for _ in 0..3 {
            assert_ne!(
                poll_once(dir.path(), CliProvider::Claude, &mode, &mut state),
                TickOutcome::Ready
            );
        }

        // The user logs in again with the expected account.
        staged_claude(
            dir.path(),
            &CLAUDE_JSON.replace("claude-account-a", "claude-account-b"),
        );
        assert_eq!(
            poll_once(dir.path(), CliProvider::Claude, &mode, &mut state),
            TickOutcome::Idle
        );
        assert_eq!(
            poll_once(dir.path(), CliProvider::Claude, &mode, &mut state),
            TickOutcome::Ready
        );
    }

    #[test]
    fn codex_staging_settles_on_its_auth_file() {
        let dir = tempdir().unwrap();
        let mut state = WatchState::new();
        fs::write(dir.path().join("auth.json"), CODEX).unwrap();
        assert_eq!(
            poll_once(dir.path(), CliProvider::Codex, &LoginMode::New, &mut state),
            TickOutcome::Idle
        );
        assert_eq!(
            poll_once(dir.path(), CliProvider::Codex, &LoginMode::New, &mut state),
            TickOutcome::Ready
        );
    }

    #[test]
    fn cancelling_ends_the_watch_and_removes_the_staging_dir() {
        let base = tempdir().unwrap();
        let dir = staging::create_staging_dir(base.path()).unwrap();
        staged_claude(&dir, CLAUDE_JSON);
        let cancel = Arc::new(AtomicBool::new(false));

        assert_eq!(
            terminal_reason(cancel.load(Ordering::SeqCst), Duration::ZERO),
            None
        );
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            terminal_reason(cancel.load(Ordering::SeqCst), Duration::ZERO),
            Some(ERR_LOGIN_CANCELLED)
        );

        staging::cleanup_staging_with_credentials(&dir, &FileCredentials);
        assert!(!dir.exists());
        // Cancellation must not have registered anything.
        assert!(super::super::registry::load(base.path())
            .unwrap()
            .profiles
            .is_empty());
    }

    #[test]
    fn a_login_that_never_finishes_times_out() {
        assert_eq!(
            terminal_reason(false, LOGIN_TIMEOUT),
            Some(ERR_LOGIN_TIMEOUT)
        );
        assert_eq!(
            terminal_reason(false, LOGIN_TIMEOUT - Duration::from_secs(1)),
            None
        );
        // Cancellation wins over a simultaneous timeout: it is the more
        // specific reason and the one the user is waiting to see.
        assert_eq!(
            terminal_reason(true, LOGIN_TIMEOUT),
            Some(ERR_LOGIN_CANCELLED)
        );
    }

    fn pending(login_id: &str, provider: CliProvider) -> PendingLogin {
        PendingLogin {
            login_id: login_id.into(),
            provider,
            dir: PathBuf::from("C:/staging").join(login_id),
            mode: LoginMode::New,
            started_at: Instant::now(),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn one_login_per_provider_at_a_time() {
        let registry = LoginRegistry::default();
        assert!(registry.try_insert(pending("a", CliProvider::Claude)));
        assert!(
            !registry.try_insert(pending("b", CliProvider::Claude)),
            "a second claude login must be refused"
        );
        assert!(registry.try_insert(pending("c", CliProvider::Codex)));
        assert_eq!(registry.list().len(), 2);

        registry.remove("a");
        assert!(registry.try_insert(pending("b", CliProvider::Claude)));
    }

    #[test]
    fn cancel_targets_a_known_session_only() {
        let registry = LoginRegistry::default();
        let entry = pending("a", CliProvider::Claude);
        let flag = entry.cancel.clone();
        registry.try_insert(entry);

        assert!(!registry.request_cancel("missing"));
        assert!(!flag.load(Ordering::SeqCst));
        assert!(registry.request_cancel("a"));
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn listed_sessions_carry_the_staging_dir_and_mode() {
        let registry = LoginRegistry::default();
        registry.try_insert(PendingLogin {
            mode: LoginMode::Reauth {
                expected_identity_key: "claude-account-a".into(),
            },
            ..pending("a", CliProvider::Claude)
        });
        let listed = registry.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].login_id, "a");
        assert_eq!(listed[0].mode, "reauth");
        assert!(listed[0].staging_dir.ends_with("a"));
    }
}
