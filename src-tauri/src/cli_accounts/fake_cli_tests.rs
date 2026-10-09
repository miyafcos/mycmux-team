//! Opt-in subprocess acceptance tests. Never resolve live CLI directories.
//! Run outside the sandbox; macOS uses only a new staging-scoped dummy item.

use super::*;
use super::login_watch::{LoginMode, TickOutcome, WatchState};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::tempdir;

const DEADLINE: Duration = Duration::from_secs(15);
const TEST_MARKER: &str = "mycmux dummy credentials only\n";

fn require_opt_in() {
    assert_eq!(std::env::var("MYCMUX_E2E_FAKE_CLI").as_deref(), Ok("1"),
        "run ignored fake CLI tests outside the sandbox with MYCMUX_E2E_FAKE_CLI=1");
}

#[cfg(target_os = "macos")]
fn assert_scoped_keychain_absent(dir: &Path) {
    let service = staging::claude_staging_service(&dir.display().to_string());
    assert_ne!(service, claude::KEYCHAIN_SERVICE);
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", &service])
        .output().expect("query only this fixture's scoped service");
    // Permission errors must not masquerade as absence. No -w or live service.
    assert_eq!(output.status.code(), Some(44), "scoped test item must be absent");
}

#[cfg(not(target_os = "macos"))]
fn assert_scoped_keychain_absent(_dir: &Path) {}

struct FakeLogin {
    dir: PathBuf,
    child: Option<Child>,
    cleaned: bool,
}

impl FakeLogin {
    fn start(base: &Path, provider: CliProvider, config_store: Option<&str>,
        override_store: Option<&str>) -> Self {
        require_opt_in();
        let dir = staging::create_staging_dir(base).unwrap();
        // Check before constructing the cleanup guard: even a hash collision
        // must never make us delete a pre-existing Keychain item.
        assert_scoped_keychain_absent(&dir);
        let mut fixture = Self { dir, child: None, cleaned: false };
        fs::write(fixture.dir.join(".fake-cli-test"), TEST_MARKER).unwrap();
        if let Some(store) = config_store {
            fs::write(fixture.dir.join("config.toml"),
                format!("cli_auth_credentials_store = \"{store}\"\n")).unwrap();
        }
        let (name, mut args, env_key) = staging::login_command(provider);
        if let Some(store) = override_store {
            args.extend(["-c".to_string(), format!("cli_auth_credentials_store=\"{store}\"")]);
        }
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
            .join("e2e/fixtures/fake-cli").join(name);
        let config_dir = if provider == CliProvider::Claude {
            staging::claude_staging_config(&fixture.dir).0
        } else {
            fixture.dir.display().to_string()
        };
        // Preserve OS login-session context for the scoped macOS Keychain,
        // while excluding API keys, tokens, CLI homes and launch flags.
        let mut command = Command::new("python3");
        command.env_clear();
        for key in ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        fixture.child = Some(command.arg("-B").arg(script).args(args)
            .env("MYCMUX_E2E_FAKE_CLI", "1").env(env_key, config_dir)
            .current_dir(&fixture.dir).stdin(Stdio::null())
            .stdout(Stdio::null()).stderr(Stdio::inherit())
            .spawn().expect("spawn Python 3.9+ fake CLI"));
        fixture
    }

    fn wait_for_marker(&mut self, marker: &str) {
        let started = Instant::now();
        while !self.dir.join(marker).exists() {
            if let Some(status) = self.child.as_mut().unwrap().try_wait().unwrap() {
                panic!("fake CLI exited before {marker}: {status}");
            }
            assert!(started.elapsed() < DEADLINE, "fake CLI marker timed out: {marker}");
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn release_credentials(&self) {
        fs::write(self.dir.join(".allow-credentials"), "").unwrap();
    }

    fn wait_for_exit(&mut self) {
        let started = Instant::now();
        loop {
            if let Some(status) = self.child.as_mut().unwrap().try_wait().unwrap() {
                if !status.success() {
                    let invocation = fs::read_to_string(self.dir.join("invocation.json")).ok()
                        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
                    if invocation.as_ref().and_then(|value| value["error_code"].as_i64()) == Some(36) {
                        panic!("login keychain locked: run from a GUI session (security exit 36)");
                    }
                    panic!("fake CLI failed: {status}");
                }
                return;
            }
            assert!(started.elapsed() < DEADLINE, "fake CLI process timed out");
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn await_ready(&self, provider: CliProvider, state: &mut WatchState) {
        let started = Instant::now();
        loop {
            match login_watch::poll_once(&self.dir, provider, &LoginMode::New, state) {
                TickOutcome::Ready => return,
                TickOutcome::Idle => {}
                outcome => panic!("unexpected watcher outcome: {outcome:?}"),
            }
            assert!(started.elapsed() < DEADLINE, "login watcher never became ready");
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn invocation(&self) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(self.dir.join("invocation.json")).unwrap()).unwrap()
    }

    fn cleanup(&mut self) {
        self.stop_child();
        staging::cleanup_staging(&self.dir);
        self.cleaned = true;
        assert!(!self.dir.exists(), "staging directory must be removed");
        assert_scoped_keychain_absent(&self.dir);
    }

    fn stop_child(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for FakeLogin {
    fn drop(&mut self) {
        // A panic cannot leave a writer running after its directory/item was
        // cleaned, nor leak dummy credentials into the next test.
        self.stop_child();
        if !self.cleaned {
            staging::cleanup_staging(&self.dir);
        }
    }
}

fn assert_registered_and_listed(base: &Path, fixture: &mut FakeLogin, provider: CliProvider,
    email: &str, identity: &str) {
    let (profile, updated) = staging::capture_staged(base, provider, &fixture.dir,
        Some("Dummy account".to_string()), None).unwrap();
    assert!(!updated);
    assert_eq!(profile.provider, provider);
    assert_eq!(profile.identity_key, identity);
    assert_eq!(profile.email.as_deref(), Some(email));
    assert!(!profile.needs_relogin);
    let saved = registry::load(base).unwrap();
    assert_eq!(saved.profiles.len(), 1);
    assert_eq!(saved.profiles[0].id, profile.id);
    snapshot::load(base, &profile.id).expect("captured snapshot must be readable");

    // Re-capture uses the production upsert path without duplicating the row.
    let (again, updated) = staging::capture_staged(base, provider, &fixture.dir, None, None).unwrap();
    assert!(updated);
    assert_eq!(again.id, profile.id);
    assert_eq!(again.label, "Dummy account");
    assert_eq!(registry::load(base).unwrap().profiles.len(), 1);
    fixture.cleanup();
    assert_eq!(fs::read_dir(staging::staging_root(base)).unwrap().count(), 0);

    // The list endpoint's shared implementation uses only blank temp live
    // paths. Captured profiles survive cleanup and do not switch the live CLI.
    let live = base.join("untouched-live");
    let cp = claude::ClaudePaths { store: claude::CredentialStore::File,
        credentials: live.join("claude-credentials.json"), claude_json: live.join("claude.json") };
    let xp = codex::CodexPaths { auth: live.join("codex-auth.json") };
    let gp = grok::GrokPaths { auth: live.join("grok-auth.json"), lock: live.join("grok-auth.json.lock") };
    let listed = list_with_grok(base, &cp, &xp, &gp).unwrap();
    assert_eq!(listed.profiles.len(), 1);
    assert_eq!(listed.profiles[0].id, profile.id);
    assert!(listed.live.iter().all(|login| !login.present));
    assert!(!live.exists());
    assert!(listed.active.claude.is_none() && listed.active.codex.is_none() && listed.active.grok.is_none());
}

fn delayed_claude(base: &Path) -> (FakeLogin, WatchState) {
    let mut fixture = FakeLogin::start(base, CliProvider::Claude, None, None);
    fixture.wait_for_marker(".identity-ready");
    let mut state = WatchState::new();
    for _ in 0..3 {
        assert_eq!(login_watch::poll_once(&fixture.dir, CliProvider::Claude,
            &LoginMode::New, &mut state), TickOutcome::Idle);
    }
    assert!(!fixture.dir.join(".credentials.json").exists());
    fixture.release_credentials();
    fixture.wait_for_exit();
    (fixture, state)
}

#[test]
#[ignore = "opt-in dummy subprocess and macOS scoped Keychain test; run outside sandbox"]
fn fake_claude_login_captures_lists_and_cleans_scoped_credentials() {
    require_opt_in();
    let base = tempdir().unwrap();
    let (mut fixture, mut state) = delayed_claude(base.path());
    #[cfg(target_os = "macos")]
    {
        assert!(!fixture.dir.join(".credentials.json").exists());
        assert_eq!(fixture.invocation()["store"], "keychain");
        assert_eq!(fixture.invocation()["service"],
            staging::claude_staging_service(&fixture.dir.display().to_string()));
    }
    fixture.await_ready(CliProvider::Claude, &mut state);
    assert_registered_and_listed(base.path(), &mut fixture, CliProvider::Claude,
        "claude@example.test", "fake-claude-account");
}

#[test]
#[ignore = "opt-in fake CLI subprocess test; run outside sandbox"]
fn fake_codex_file_override_captures_lists_and_cleans_for_keyring_and_auto_configs() {
    require_opt_in();
    for store in ["keyring", "auto"] {
        let base = tempdir().unwrap();
        let mut fixture = FakeLogin::start(base.path(), CliProvider::Codex, Some(store), None);
        fixture.wait_for_exit();
        assert_eq!(fixture.invocation()["store"], "file");
        assert_eq!(fixture.invocation()["file_override"], true);
        let auth: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(fixture.dir.join("auth.json")).unwrap()).unwrap();
        for key in ["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens"] {
            assert!(auth.get(key).is_some(), "real Codex auth field missing: {key}");
        }
        fixture.await_ready(CliProvider::Codex, &mut WatchState::new());
        assert_registered_and_listed(base.path(), &mut fixture, CliProvider::Codex,
            "codex@example.test", "fake-codex-account");
    }
}

#[test]
#[ignore = "opt-in fake CLI subprocess test; run outside sandbox"]
fn fake_grok_locked_login_captures_lists_and_cleans_credentials() {
    require_opt_in();
    let base = tempdir().unwrap();
    let mut fixture = FakeLogin::start(base.path(), CliProvider::Grok, None, None);
    fixture.wait_for_marker(".lock-ready");
    assert!(fixture.dir.join("auth.json.lock").exists());
    assert!(!fixture.dir.join("auth.json").exists());
    let mut state = WatchState::new();
    assert_eq!(login_watch::poll_once(&fixture.dir, CliProvider::Grok,
        &LoginMode::New, &mut state), TickOutcome::Idle);
    fixture.release_credentials();
    fixture.wait_for_exit();
    assert!(!fixture.dir.join("auth.json.lock").exists());
    assert_eq!(fixture.invocation()["lock_acquired"], true);
    fixture.await_ready(CliProvider::Grok, &mut state);
    assert_registered_and_listed(base.path(), &mut fixture, CliProvider::Grok,
        "grok@example.test", "fake-grok-user");
}

#[test]
#[ignore = "opt-in storage-hole subprocess reproduction; run outside sandbox"]
fn fake_codex_keyring_and_auto_without_file_auth_report_storage_timeout() {
    require_opt_in();
    for store in ["keyring", "auto"] {
        let base = tempdir().unwrap();
        let mut fixture = FakeLogin::start(base.path(), CliProvider::Codex, Some(store), Some(store));
        fixture.wait_for_exit();
        assert_eq!(fixture.invocation()["store"], store);
        assert_eq!(fixture.invocation()["file_override"], false);
        assert!(!fixture.dir.join("auth.json").exists());
        for _ in 0..3 {
            assert_eq!(login_watch::poll_once(&fixture.dir, CliProvider::Codex,
                &LoginMode::New, &mut WatchState::new()), TickOutcome::Idle);
        }
        assert_eq!(login_watch::cleanup_login_if_terminal(&fixture.dir, CliProvider::Codex,
            false, Duration::from_secs(600), &staging::NativeCredentials),
            Some(ERR_CODEX_LOGIN_FILE_MISSING));
        fixture.cleaned = true;
        assert!(!fixture.dir.exists());
        assert_scoped_keychain_absent(&fixture.dir);
        assert!(registry::load(base.path()).unwrap().profiles.is_empty());
        assert!(!snapshot::snapshot_dir(base.path()).exists());
    }
}

#[test]
#[ignore = "opt-in cancellation cleanup of dummy macOS Keychain item; run outside sandbox"]
fn fake_claude_cancellation_cleans_scoped_credentials() {
    require_opt_in();
    let base = tempdir().unwrap();
    let (mut fixture, _) = delayed_claude(base.path());
    assert_eq!(login_watch::cleanup_login_if_terminal(&fixture.dir, CliProvider::Claude,
        true, Duration::from_secs(600), &staging::NativeCredentials), Some(ERR_LOGIN_CANCELLED));
    fixture.cleaned = true;
    assert!(!fixture.dir.exists());
    assert_scoped_keychain_absent(&fixture.dir);
    assert!(registry::load(base.path()).unwrap().profiles.is_empty());
}

#[test]
#[ignore = "opt-in timeout cleanup of dummy macOS Keychain item; run outside sandbox"]
fn fake_claude_timeout_cleans_scoped_credentials() {
    require_opt_in();
    let base = tempdir().unwrap();
    let (mut fixture, _) = delayed_claude(base.path());
    assert_eq!(login_watch::cleanup_login_if_terminal(&fixture.dir, CliProvider::Claude,
        false, Duration::from_secs(600), &staging::NativeCredentials), Some(ERR_LOGIN_TIMEOUT));
    fixture.cleaned = true;
    assert!(!fixture.dir.exists());
    assert_scoped_keychain_absent(&fixture.dir);
    assert!(registry::load(base.path()).unwrap().profiles.is_empty());
}
