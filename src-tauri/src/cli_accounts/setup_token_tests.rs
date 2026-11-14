use super::*;
use crate::cli_accounts::{registry, CliAccountProfile, CliProvider,
    claude::{ClaudePaths, CredentialStore}};
#[cfg(unix)]
use crate::cli_accounts::token_owner::{OwnerCheck, TokenOwner};
use std::{cell::RefCell, collections::HashMap, fs};
#[cfg(unix)]
use std::sync::Arc;
const ID: &str = "claude-1a2b3c4d";

#[derive(Default)]
struct MemoryStore(RefCell<HashMap<String, String>>);
impl LaunchTokenStore for MemoryStore {
    fn read(&self, id: &str) -> Result<Option<String>, String> { Ok(self.0.borrow().get(id).cloned()) }
    fn write(&self, id: &str, value: &str) -> Result<(), String> { self.0.borrow_mut().insert(id.into(), value.into()); Ok(()) }
    fn delete(&self, id: &str) -> Result<(), String> { self.0.borrow_mut().remove(id); Ok(()) }
}
struct NoCredentials;
impl staging::StagingCredentials for NoCredentials {
    fn claude_paths(&self, dir: &Path) -> ClaudePaths {
        ClaudePaths { credentials: dir.join(".credentials.json"), claude_json: dir.join(".claude.json"), store: CredentialStore::File }
    }
    fn read(&self, _: &ClaudePaths) -> crate::cli_accounts::claude::CredentialsRead { panic!("must not read credentials") }
    fn remove_keychain(&self, _: &str) { panic!("must not access the OS store") }
}
fn fake_token() -> String { format!("sk-ant-oat01-{}", "a".repeat(95)) }
#[cfg(unix)]
fn fixture_token(base: &Path) -> String {
    let seed: String = base.file_name().unwrap().to_string_lossy().chars().filter(char::is_ascii_alphanumeric).collect();
    format!("sk-ant-oat01-{}", seed.chars().cycle().take(95).collect::<String>())
}
#[cfg(unix)]
fn owner(mismatch: bool) -> LaunchOwnerCheck {
    OwnerCheck::Owner(TokenOwner { account_uuid: if mismatch { "other" } else { "owner-1" }.into(),
        email: None, organization_uuid: None }).into()
}

#[test]
fn setup_token_parser_requires_a_single_complete_standalone_line_after_the_marker() {
    let token = fake_token();
    let good = format!("Your OAuth token:\n  {token}  \n");
    assert_eq!(extract_token(good.as_bytes()).unwrap().as_slice(), token.as_bytes());
    for bad in [
        format!("{token}\n"), format!("{token}\nOAuth token\n"), format!("OAuth token\nprefix {token}\n"),
        format!("OAuth token\n{token} suffix\n"), format!("OAuth token\n{token}\n{token}b\n"),
        format!("OAuth token\n{}\n{}\n", &token[..50], &token[50..]),
        format!("OAuth token\n{token}"),
    ] { assert!(extract_token(bad.as_bytes()).is_none(), "reject ambiguous or incomplete output"); }
}
#[test]
fn setup_token_removes_ansi_even_inside_the_token_and_hides_unsafe_urls() {
    let token = fake_token();
    let raw = format!("\x1b]0;private title\x07\x1b[32mOAuth token\x1b[0m\r\n{}\x1b[33m{}\x1b[0m\r\n", &token[..30], &token[30..]);
    let plain = strip_controls(raw.as_bytes());
    assert_eq!(extract_token(plain.as_slice()).unwrap().as_slice(), token.as_bytes());
    assert_eq!(authorization_url(b"Open https://example.test/oauth/authorize?state=fixture\n").as_deref(),
        Some("https://example.test/oauth/authorize?state=fixture"));
    assert!(authorization_url(format!("https://example.test/oauth/authorize?state={token}\n").as_bytes()).is_none());
}
#[test]
fn setup_token_scrubs_all_inherited_auth_and_internal_aliases_without_changing_normal_launches() {
    let mut cmd = CommandBuilder::new("fixture-never-executed");
    cmd.env_clear();
    for key in AUTH_ENV_KEYS { cmd.env(*key, "fixture"); cmd.env(key.to_ascii_lowercase(), "fixture"); }
    cmd.env("MYCMUX_SESSION_ID", "fixture");
    cmd.env("mycmux_parent", "fixture");
    cmd.env("KEEP", "kept");
    scrub_setup_env(&mut cmd);
    let names: Vec<_> = cmd.iter_full_env_as_str().map(|(k, _)| k.to_owned()).collect();
    assert_eq!(names, vec!["KEEP"]);
}
#[test]
fn setup_token_registry_allows_one_attempt_and_accepts_only_a_single_word_code_with_hash() {
    let reg = SetupTokenRegistry::default();
    let (first, _control) = reg.begin(ID).unwrap();
    assert!(reg.begin(ID).is_err());
    reg.publish(&first.login_id, SetupTokenState::CodeAvailable, None, None, None);
    for value in ["", "without-hash", "two words#state", "a#b\n", "\x1b#state", "#", "a#"] {
        assert!(reg.submit_code(&first.login_id, value.into()).is_err());
    }
    reg.submit_code(&first.login_id, "fixture-code#fixture-state".into()).unwrap();
    assert!(reg.submit_code(&first.login_id, "second#state".into()).is_err());
    reg.cancel(&first.login_id).unwrap();
    assert!(reg.current().unwrap().is_some());
}
#[test]
fn setup_token_sensitive_storage_is_overwritten_before_release() {
    let mut bytes = SecretBytes(fake_token().into_bytes());
    bytes.wipe();
    assert!(!bytes.0.is_empty());
    assert!(bytes.0.iter().all(|byte| *byte == 0));
}

#[cfg(unix)]
fn fixture(mode: &str) -> (tempfile::TempDir, CommandBuilder, ClaudePaths) {
    use std::os::unix::fs::PermissionsExt;
    let base = tempfile::tempdir().unwrap();
    let profile = CliAccountProfile { id: ID.into(), provider: CliProvider::Claude, label: "fixture".into(),
        email: None, identity_key: "owner-1".into(), plan: None, org_name: None, captured_at: String::new(),
        last_switched_at: None, needs_relogin: false, refresh_rejected_at: None, foreign_token_owner: None };
    registry::save(base.path(), &registry::CliAccountsFile { profiles: vec![profile], ..Default::default() }).unwrap();
    let script = base.path().join("fixture-claude");
    let report = serde_json::to_string(&base.path().join("report.json").to_string_lossy()).unwrap();
    let script_text = format!(r#"#!/usr/bin/env python3
import sys, os, json, time, signal, tty, select
mode = {mode:?}
report = {report}
size = os.get_terminal_size(1)
info = {{'args': sys.argv[1:], 'config': os.environ.get('CLAUDE_CONFIG_DIR'), 'cols': size.columns, 'rows': size.lines,
         'leaked': [k for k in os.environ if k.upper() in {keys:?} or k.upper().startswith('MYCMUX_')]}}
with open(report, 'w') as f: json.dump(info, f)
print('fixture ' + json.dumps(info), flush=True)
token = {token:?}
if mode == 'code_separate': tty.setraw(0)
print('\033[32mOpen https://example.test/oauth/authorize?state=fixture\033[0m', flush=True)
if mode in ('descendant', 'escaped_descendant'):
    r, w = os.pipe()
    if os.fork() == 0:
        os.close(r)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        if mode == 'escaped_descendant': os.setsid()
        os.write(w, b'1'); os.close(w)
        time.sleep(5)
        os._exit(0)
    os.close(w); os.read(r, 1); os.close(r)
    open(report + '.exited', 'w').close()
    sys.exit(0)
if mode == 'notice': print('Update check failed; error reporting is enabled; press enter in settings; notice not shown', flush=True)
if mode == 'invalid_utf8': os.write(1, b'bad \xff header\n')
if mode == 'large': print('x' * (300 * 1024), flush=True)
if mode in ('timeout', 'cancel'): time.sleep(30)
elif mode == 'overflow': print('x' * (1024 * 1024 + 1), flush=True); time.sleep(30)
elif mode == 'exit': pass
elif mode == 'error':
    print('OAuth error: Failed to exchange authorization code for access token. Please try again.', flush=True)
    print('Press Enter to retry.', flush=True); time.sleep(30)
elif mode == 'press_enter':
    print('Press Enter to retry', flush=True); time.sleep(30)
else:
    if mode == 'code_separate':
        code = b''
        first = None
        while not code.endswith(b'\r'):
            chunk = os.read(0, 4096)
            if first is None: first = time.monotonic()
            code += chunk
        if code != b'fixture-code#fixture-state\r' or time.monotonic() - first < 0.14: sys.exit(3)
    if mode == 'code':
        code = sys.stdin.readline().strip()
        if code != 'fixture-code#fixture-state': sys.exit(2)
    if mode == 'conpty':
        screen = '\033[2KYour OAuth token (valid for 1 year):\033[5;1H' + token + '\033[B'
        os.write(1, (screen + '\033[2K' + screen).encode())
    elif mode != 'no_marker': print('\033[1mYour OAuth token:\033[0m', flush=True)
    if mode == 'conpty': pass
    elif mode == 'extra': print('prefix ' + token, flush=True)
    elif mode == 'two':
        print(token, flush=True); time.sleep(0.04); print(token + 'b', flush=True)
    elif mode == 'wrapped': print(token[:50] + '\n' + token[50:], flush=True)
    elif mode == 'ansi_split':
        os.write(1, token[:30].encode()); os.write(1, b'\033[33m'); os.write(1, token[30:].encode() + b'\033[0m\n')
    else: print(token, flush=True)
    if mode == 'bad_exit': sys.exit(1)
    if mode == 'linger': time.sleep(30)
"#, keys=AUTH_ENV_KEYS, token=fixture_token(base.path()));
    fs::write(&script, script_text).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let live = ClaudePaths { credentials: base.path().join("must-not-read-credentials"),
        claude_json: base.path().join("live-config.json"), store: CredentialStore::File };
    fs::write(&live.claude_json, r#"{"theme":"dark","oauthAccount":{"accountUuid":"not-copied"},"apiKey":"not-copied"}"#).unwrap();
    let mut cmd = CommandBuilder::new(script);
    cmd.arg("setup-token");
    for key in AUTH_ENV_KEYS { cmd.env(*key, "dummy-inherited"); }
    cmd.env("MYCMUX_SESSION_ID", "dummy-inherited");
    (base, cmd, live)
}
#[cfg(unix)]
fn run_fake(mode: &str, mismatch: bool) -> (tempfile::TempDir, MemoryStore, Vec<SetupTokenEvent>, RunAudit) {
    let (base, cmd, live) = fixture(mode);
    let store = MemoryStore::default();
    let registry = Arc::new(SetupTokenRegistry::default());
    let (initial, control) = registry.begin(ID).unwrap();
    let actor = if matches!(mode, "cancel" | "code" | "code_separate") {
        let registry = registry.clone();
        let id = initial.login_id.clone();
        let is_code = matches!(mode, "code" | "code_separate");
        Some(std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if registry.current().unwrap().is_some_and(|event| event.state == SetupTokenState::CodeAvailable && event.url.is_some()) {
                    if is_code { registry.submit_code(&id, "fixture-code#fixture-state".into()).unwrap(); }
                    else { registry.cancel(&id).unwrap(); }
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            panic!("fake CLI did not reach code state: {:?}", registry.current().unwrap().map(|event| (event.state, event.url.is_some())));
        }))
    } else { None };
    let mut events = vec![initial.clone()];
    let audit = run_attempt(&registry, initial, control, base.path(), &live, cmd,
        RunOptions { timeout: Duration::from_secs(if mode == "timeout" { 2 } else { 20 }), token_exit_grace: Duration::from_millis(150), fallback_after: Duration::from_millis(50) },
        &store, |_| owner(mismatch), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials),
        |event| events.push(event));
    if let Some(actor) = actor { actor.join().unwrap(); }
    assert!(audit.child_stopped);
    assert!(audit.wiped_buffer.iter().all(|byte| *byte == 0));
    assert!(!String::from_utf8_lossy(&audit.wiped_buffer).contains("sk-ant-oat"));
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
    for event in &events {
        let json = serde_json::to_value(event).unwrap();
        assert!(json.as_object().unwrap().keys().all(|key| ["login_id","profile_id","state","url","reason","status"].contains(&key.as_str())));
        assert!(!json.to_string().contains("sk-ant-oat"));
    }
    (base, store, events, audit)
}
#[cfg(unix)]
#[test]
fn setup_token_fake_cli_saves_and_cleans_with_exact_args_size_and_isolated_environment() {
    let (base, store, events, _) = run_fake("success", false);
    assert_eq!(store.0.borrow().get(ID), Some(&fixture_token(base.path())));
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert!(events.iter().any(|event| event.state == SetupTokenState::CheckingOwner));
    let report: serde_json::Value = serde_json::from_slice(&fs::read(base.path().join("report.json")).unwrap()).unwrap();
    assert_eq!(report["args"], serde_json::json!(["setup-token"]));
    assert_eq!(report["cols"], 512);
    assert_eq!(report["rows"], 40);
    assert_eq!(report["leaked"], serde_json::json!([]));
    assert!(Path::new(report["config"].as_str().unwrap()).starts_with(staging::staging_root(base.path())));
    assert!(!fs::read_to_string(base.path().join("cli_account_launch_tokens.json")).unwrap().contains("sk-ant-oat"));
}
#[cfg(unix)]
#[test]
fn setup_token_fake_cli_accepts_ink_colors_and_code_submission() {
    for mode in ["ansi_split", "code", "linger"] {
        let (base, store, events, _) = run_fake(mode, false);
        assert_eq!(events.last().unwrap().state, SetupTokenState::Saved, "{mode}");
        assert_eq!(store.0.borrow().get(ID), Some(&fixture_token(base.path())));
        if mode == "code" { assert!(events.iter().any(|event| event.state == SetupTokenState::CodeAvailable)); }
    }
}
#[cfg(unix)]
#[test]
fn setup_token_fake_cli_rejects_ambiguous_missing_or_wrapped_tokens_without_saving() {
    for mode in ["extra", "no_marker", "two", "wrapped", "exit"] {
        let (_, store, events, _) = run_fake(mode, false);
        assert!(store.0.borrow().is_empty(), "{mode}");
        assert_eq!(events.last().unwrap().state, SetupTokenState::Failed, "{mode}");
        assert_eq!(events.last().unwrap().reason.as_deref(), Some("capture_failed"));
    }
}
#[cfg(unix)]
#[test]
fn setup_token_fake_cli_stops_on_errors_timeout_cancellation_and_bounded_output() {
    for (mode, state, reason) in [
        ("error", SetupTokenState::Failed, "cli_error"), ("press_enter", SetupTokenState::Failed, "cli_error"),
        ("timeout", SetupTokenState::Timeout, "timeout"), ("cancel", SetupTokenState::Cancelled, "cancelled"),
        ("overflow", SetupTokenState::Failed, "output_limit"),
    ] {
        let (_, store, events, _) = run_fake(mode, false);
        assert!(store.0.borrow().is_empty());
        assert_eq!(events.last().unwrap().state, state, "{mode}");
        assert_eq!(events.last().unwrap().reason.as_deref(), Some(reason));
    }
}
#[cfg(unix)]
#[test]
fn setup_token_fake_cli_owner_mismatch_never_saves_the_new_token() {
    let (_, store, events, _) = run_fake("success", true);
    assert!(store.0.borrow().is_empty());
    assert_eq!(events.last().unwrap().state, SetupTokenState::Mismatch);
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("owner_mismatch"));
}
#[test]
fn setup_token_staging_seed_and_crash_sweep_use_only_the_disposable_directory() {
    let base = tempfile::tempdir().unwrap();
    let dir = staging::create_staging_dir(base.path()).unwrap();
    let live = ClaudePaths { credentials: base.path().join("must-not-read"), claude_json: base.path().join("config.json"), store: CredentialStore::File };
    fs::write(&live.claude_json, r#"{"theme":"dark","oauthAccount":{"accountUuid":"not-copied"}}"#).unwrap();
    staging::seed_claude_staging(&dir, &live);
    let seeded: serde_json::Value = serde_json::from_slice(&fs::read(dir.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(seeded, serde_json::json!({"theme":"dark"}));
    staging::sweep_stale_staging_with_credentials(base.path(), Duration::ZERO, &NoCredentials);
    assert!(!dir.exists());
}

#[cfg(unix)]
#[test]
fn setup_token_fake_cli_rejects_a_token_followed_by_unsuccessful_exit() {
    let (_, store, events, _) = run_fake("bad_exit", false);
    assert!(store.0.borrow().is_empty());
    assert_eq!(events.last().unwrap().state, SetupTokenState::Failed);
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("cli_error"));
}
#[cfg(unix)]
#[test]
fn setup_token_cancellation_during_owner_lookup_prevents_the_local_commit() {
    let (base, cmd, live) = fixture("success");
    let store = MemoryStore::default();
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let id = initial.login_id.clone();
    let audit = run_attempt(&registry, initial, control, base.path(), &live, cmd, RunOptions::default(), &store,
        |_| { registry.cancel(&id).unwrap(); owner(false) },
        |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
    assert!(store.0.borrow().is_empty());
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::Cancelled);
    assert!(audit.child_stopped && audit.wiped_buffer.iter().all(|byte| *byte == 0));
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
}
#[test]
fn setup_token_spawn_failure_releases_the_single_attempt_and_cleans_staging() {
    let base = tempfile::tempdir().unwrap();
    let live = ClaudePaths { credentials: base.path().join("must-not-read"), claude_json: base.path().join("missing-config"), store: CredentialStore::File };
    let store = MemoryStore::default();
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let audit = run_attempt(&registry, initial, control, base.path(), &live,
        CommandBuilder::new(base.path().join("nonexistent-fixture-cli")), RunOptions::default(), &store,
        |_| panic!("must not check the owner on spawn failure"),
        |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
    assert_eq!(registry.current().unwrap().unwrap().reason.as_deref(), Some("launch_failed"));
    assert!(audit.child_stopped && audit.wiped_buffer.is_empty());
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
    assert!(registry.begin(ID).is_ok());
}

#[test]
fn setup_token_cancelled_before_spawn_never_runs_the_command() {
    let base = tempfile::tempdir().unwrap();
    let live = ClaudePaths { credentials: base.path().join("must-not-read"), claude_json: base.path().join("missing"), store: CredentialStore::File };
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    registry.cancel(&initial.login_id).unwrap();
    run_attempt(&registry, initial, control, base.path(), &live,
        CommandBuilder::new(base.path().join("must-not-spawn")), RunOptions::default(), &MemoryStore::default(),
        |_| panic!("must not look up an owner"), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::Cancelled);
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
}


#[test]
fn setup_token_cursor_sequences_separate_lines_but_colors_join() {
    let token = fake_token();
    for boundary in ["\x1b[5;1H", "\x1b[B", "\x1b[5d"] {
        let output = format!("Your OAuth token:{boundary}{token}{boundary}");
        let plain = strip_controls(output.as_bytes());
        assert_eq!(extract_token(plain.as_slice()).map(|v| v.as_slice().to_vec()), Some(token.as_bytes().to_vec()));
        let split = format!("OAuth token\n{}{boundary}{}\n", &token[..50], &token[50..]);
        assert!(extract_token(strip_controls(split.as_bytes()).as_slice()).is_none());
    }
}
#[test]
fn setup_token_repeated_identical_tokens_count_as_one_value() {
    let token = fake_token();
    let text = format!("OAuth token\n{token}\nOAuth token\n{token}\n");
    assert_eq!(extract_token(text.as_bytes()).map(|v| v.as_slice().to_vec()), Some(token.as_bytes().to_vec()));
    assert!(extract_token(format!("{text}{token}b\n").as_bytes()).is_none());
}
#[test]
fn setup_token_invalid_utf8_in_unrelated_lines_preserves_ascii_token_and_url() {
    let token = fake_token();
    let mut text = b"invalid \xff header\nhttps://example.test/oauth/authorize?state=fixture\nOAuth token\n".to_vec();
    text.extend_from_slice(format!("{token}\n").as_bytes());
    assert_eq!(authorization_url(&text).as_deref(), Some("https://example.test/oauth/authorize?state=fixture"));
    assert_eq!(extract_token(&text).map(|v| v.as_slice().to_vec()), Some(token.as_bytes().to_vec()));
}
#[test]
fn setup_token_esc_intermediates_and_final_byte_do_not_leak_into_text() {
    let token = fake_token();
    let text = format!("\x1b(BYour OAuth token:\n\x1b( B{token}\n");
    let plain = strip_controls(text.as_bytes());
    assert_eq!(plain.as_slice(), format!("Your OAuth token:\n{token}\n").as_bytes());
    assert!(extract_token(plain.as_slice()).is_some());
}
#[test]
fn setup_token_only_recognizes_real_error_lines_outside_urls_and_tokens() {
    let token_notice = format!("sk-ant-oat01-{}", "error_failed_not_shown_".repeat(2));
    assert!(valid_token(&token_notice));
    for notice in ["Update check failed", "error reporting is enabled", "press enter in settings", "Notice not shown",
        "https://example.test/authorize?message=OAuth error: failed", token_notice.as_str(),
        "A notice quotes OAuth error: but is not an error", "please press enter later",
        "A notice quotes Press Enter to retry.", "A notice quotes Your account is on hold."] {
        assert!(!cli_error(notice.as_bytes()), "unrelated notice must not abort");
    }
    for message in ["OAuth error: invalid grant", "Press Enter to retry.",
        "Anthropic reported the token revoked; it was not shown."] {
        assert!(cli_error(message.as_bytes()), "real setup-token failure must abort");
    }
}
#[test]
fn setup_token_output_budget_is_one_mebibyte() {
    assert_eq!(OUTPUT_LIMIT, 1024 * 1024);
}
#[test]
fn setup_token_commit_drops_registry_lock_before_saving() {
    let registry = SetupTokenRegistry::default();
    let (initial, _control) = registry.begin(ID).unwrap();
    let result = registry.commit(&initial.login_id, || {
        let inner = registry.inner.try_lock().expect("save must not hold the registry lock");
        assert!(!inner.as_ref().unwrap().accepting_cancel);
        Err("fixture-save-failure".into())
    });
    assert!(result.is_err());
    assert!(registry.current().is_ok());
}
#[test]
fn setup_token_terminal_publication_recovers_a_poisoned_registry() {
    let registry = SetupTokenRegistry::default();
    let (initial, _control) = registry.begin(ID).unwrap();
    let _ = std::panic::catch_unwind(|| { let _lock = registry.inner.lock().unwrap(); panic!("fixture poison"); });
    let event = registry.publish(&initial.login_id, SetupTokenState::Failed, None, Some("save_failed".into()), None);
    assert!(event.is_some());
    assert!(registry.begin(ID).is_ok());
}
#[cfg(unix)]
#[test]
fn setup_token_fake_cli_handles_conpty_redraw_and_unique_per_attempt_tokens() {
    let (base, store, events, _) = run_fake("conpty", false);
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(store.0.borrow().get(ID), Some(&fixture_token(base.path())));
    let other = fixture("conpty").0;
    assert_ne!(fixture_token(base.path()), fixture_token(other.path()));
}
#[cfg(unix)]
#[test]
fn setup_token_fake_cli_separates_code_and_enter_by_at_least_150ms() {
    let (_, _, events, _) = run_fake("code_separate", false);
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
}
#[cfg(unix)]
#[test]
fn setup_token_fake_cli_preserves_success_through_notices_invalid_utf8_and_large_output() {
    for mode in ["notice", "invalid_utf8", "large"] {
        let (_, _, events, _) = run_fake(mode, false);
        assert_eq!(events.last().unwrap().state, SetupTokenState::Saved, "{mode}");
    }
}
#[cfg(unix)]
#[test]
fn setup_token_panic_emits_failure_releases_attempt_and_cleans_staging() {
    let (base, cmd, live) = fixture("success");
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let mut events = Vec::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_attempt(&registry, initial, control, base.path(), &live, cmd, RunOptions::default(), &MemoryStore::default(),
            |_| panic!("fixture owner panic"), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials),
            |event| events.push(event));
    }));
    assert!(result.is_err());
    assert_eq!(events.last().unwrap().state, SetupTokenState::Failed);
    assert!(registry.begin(ID).is_ok());
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
}
#[cfg(unix)]
#[test]
fn setup_token_descendant_drain_is_bounded_and_rejects_late_codes() {
    for mode in ["descendant", "escaped_descendant"] {
        let (base, cmd, live) = fixture(mode);
        let registry = Arc::new(SetupTokenRegistry::default());
        let (initial, control) = registry.begin(ID).unwrap();
        let actor = {
            let registry = registry.clone();
            let id = initial.login_id.clone();
            let exited = base.path().join("report.json.exited");
            std::thread::spawn(move || {
                // Fixture start-up is slow under the full parallel suite; only the drain after the exit is bounded.
                let deadline = Instant::now() + Duration::from_secs(20);
                while !exited.exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
                assert!(exited.exists());
                let exited_at = Instant::now();
                std::thread::sleep(Duration::from_millis(300));
                (registry.submit_code(&id, "fixture-code#fixture-state".into()), exited_at)
            })
        };
        let audit = run_attempt(&registry, initial, control, base.path(), &live, cmd,
            RunOptions { timeout: Duration::from_secs(25), fallback_after: Duration::ZERO, ..RunOptions::default() },
            &MemoryStore::default(), |_| panic!("no token"),
            |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
        let returned_at = Instant::now();
        let (late_code, exited_at) = actor.join().unwrap();
        assert!(late_code.is_err(), "no codes after read loop ends");
        // The descendant lives 5 s after the parent exits; the attempt must return well before that. On macOS the
        // real PTY does not keep the drain waiting (a 10 s deadline also passed on 2026-11-14), so the deadline
        // itself is covered by setup_token_drain_deadline_does_not_wait_for_a_reader_that_never_closes.
        let elapsed = returned_at.duration_since(exited_at);
        assert!(elapsed < Duration::from_millis(3500), "bounded drain exceeded deadline: {elapsed:?}");
        assert!(audit.child_stopped && audit.wiped_buffer.iter().all(|b| *b == 0));
        assert!(registry.begin(ID).is_ok());
    }
}


#[cfg(target_os = "macos")]
#[test]
fn setup_token_native_command_resolves_and_passes_the_supplied_login_path_after_scrubbing() {
    let (base, _, _) = fixture("success");
    let executable = base.path().join("claude");
    fs::rename(base.path().join("fixture-claude"), &executable).unwrap();
    let path = format!("{}:/usr/bin:/bin", base.path().display());
    let mut command = native_command(Some(&path));
    for key in AUTH_ENV_KEYS { command.env(*key, "fixture-secret"); }
    command.env("MYCMUX_SESSION_ID", "fixture-only");
    scrub_setup_env(&mut command);
    assert_eq!(command.get_argv()[0], executable.as_os_str());
    assert_eq!(command.get_env("PATH"), Some(std::ffi::OsStr::new(&path)));
    for key in AUTH_ENV_KEYS { assert!(command.get_env(key).is_none()); }
    assert!(command.get_env("MYCMUX_SESSION_ID").is_none());
}
#[test]
fn setup_token_drain_deadline_does_not_wait_for_a_reader_that_never_closes() {
    let (sender, receiver) = mpsc::sync_channel(2);
    assert!(sender.send(SecretBytes(b"fixture output".to_vec())).is_ok());
    let mut raw = SecretBytes(Vec::with_capacity(OUTPUT_LIMIT));
    let start = Instant::now();
    assert_eq!(drain_output(&receiver, &mut raw, Duration::from_millis(30)), Err("capture_failed"));
    assert!(start.elapsed() < Duration::from_millis(300));
    assert_eq!(raw.as_slice(), b"fixture output");
    raw.wipe();
    assert!(raw.0.iter().all(|byte| *byte == 0));
    drop(sender);
}
#[test]
fn setup_token_read_loop_closes_code_input_before_drain_and_owner_lookup() {
    let registry = SetupTokenRegistry::default();
    let (initial, _control) = registry.begin(ID).unwrap();
    registry.publish(&initial.login_id, SetupTokenState::CodeAvailable, None, None, None);
    registry.close_input(&initial.login_id);
    assert_eq!(registry.submit_code(&initial.login_id, "fixture-code#fixture-state".into()), Err(UNAVAILABLE.into()));
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::CodeAvailable);
    registry.cancel(&initial.login_id).unwrap();
}

#[test]
fn setup_token_trailing_erase_does_not_complete_a_token_fragment() {
    let token = fake_token();
    let output = format!("Your OAuth token:\n{}\x1b[K", &token[..50]);
    assert!(extract_token(strip_controls(output.as_bytes()).as_slice()).is_none());
}
#[test]
fn setup_token_unfinished_csi_does_not_complete_a_token_fragment() {
    let token = fake_token();
    for tail in ["\x1b[", "\x1b[12;"] {
        let output = format!("Your OAuth token:\n{}{tail}", &token[..50]);
        assert!(extract_token(strip_controls(output.as_bytes()).as_slice()).is_none());
    }
}
#[test]
fn setup_token_redrawn_heading_does_not_hide_a_wrapped_continuation() {
    let token = fake_token();
    let output = format!("Your OAuth token:\n{}\nYour OAuth token:\n{}\n", &token[..50], &token[50..]);
    assert!(extract_token(output.as_bytes()).is_none());
    let redraw = format!("Your OAuth token:\n{token}\nYour OAuth token:\n{token}\n");
    assert_eq!(extract_token(redraw.as_bytes()).unwrap().as_slice(), token.as_bytes());
}
#[test]
fn setup_token_error_markers_follow_terminal_prefix_whole_line_and_suffix_shapes() {
    for error in ["OAuth error: Failed to exchange authorization code for access token. Please try again.",
        "Press Enter to retry", "Press Enter to retry.",
        "The organization gate failed. Anthropic reported the token revoked; it was not shown."] {
        assert!(cli_error(error.as_bytes()), "terminal error shape must abort");
    }
    for notice in ["Failed to exchange authorization code for access token. Please try again.",
        "Your account is on hold.", "A notice quotes OAuth error: invalid grant",
        "Press Enter to retry. (quoted)", "Anthropic reported the token revoked; it was not shown. (quoted)"] {
        assert!(!cli_error(notice.as_bytes()), "non-terminal error shape must not abort");
    }
}
#[test]
fn setup_token_authorization_url_skips_startup_links_and_requires_the_oauth_route() {
    let output = b"Release notes https://example.test/news\nOpen https://example.test/oauth/authorize?state=fixture\n";
    assert_eq!(authorization_url(output).as_deref(), Some("https://example.test/oauth/authorize?state=fixture"));
    assert!(authorization_url(b"https://example.test/news\nhttps://example.test/oauth/authorize\n").is_none());
}

#[cfg(unix)]
#[test]
fn setup_token_blocked_pty_close_does_not_delay_terminal_state_or_release() {
    let (base, cmd, live) = fixture("exit");
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let (finished_tx, finished_rx) = mpsc::sync_channel(1);
    let mut events = Vec::new();
    let audit = run_attempt_with_close(&registry, initial, control, base.path(), &live, cmd, RunOptions::default(),
        &MemoryStore::default(), |_| panic!("no token"), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials),
        |event| events.push(event), move |pty| {
            started_tx.send(Instant::now()).unwrap();
            // A watchdog bounds the failing version; the passing version releases
            // this stand-in for a stuck ClosePseudoConsole only after returning.
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
            drop(pty);
            let _ = finished_tx.send(());
        });
    let returned_at = Instant::now();
    let started_at = started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let _ = release_tx.send(());
    finished_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(returned_at.duration_since(started_at) < Duration::from_secs(3), "close must not block the terminal event");
    assert_eq!(events.last().unwrap().state, SetupTokenState::Failed);
    assert!(registry.begin(ID).is_ok(), "terminal state releases the single-attempt gate");
    assert!(audit.child_stopped && audit.wiped_buffer.iter().all(|byte| *byte == 0));
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
}


// The shutdown fixtures use the same isolated profile and in-memory secret store
// as the existing PTY tests, with Python invoked directly on either platform.
fn shutdown_fixture(mode: &str) -> (tempfile::TempDir, CommandBuilder, ClaudePaths) {
    let base = tempfile::tempdir().unwrap();
    let profile = CliAccountProfile { id: ID.into(), provider: CliProvider::Claude, label: "fixture".into(),
        email: None, identity_key: "owner-1".into(), plan: None, org_name: None, captured_at: String::new(),
        last_switched_at: None, needs_relogin: false, refresh_rejected_at: None, foreign_token_owner: None };
    registry::save(base.path(), &registry::CliAccountsFile { profiles: vec![profile], ..Default::default() }).unwrap();
    let script = r#"
import sys, os, time, signal
mode, report, token = sys.argv[1:]
with open(report, 'w') as f: f.write(str(os.getpid()))
if mode == 'descendant':
    ready_r, ready_w = os.pipe()
    if os.fork() == 0:
        os.close(ready_r)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        with open(report + '.grandchild', 'w') as f: f.write(str(os.getpid()))
        os.write(ready_w, b'1')
        os.close(ready_w)
        time.sleep(30)
        os._exit(0)
    os.close(ready_w)
    os.read(ready_r, 1)
    os.close(ready_r)
print('Open https://example.test/oauth/authorize?state=fixture', flush=True)
if mode in ('wait', 'descendant'): time.sleep(30)
else: print('Your OAuth token:\n' + token, flush=True)
"#;
    let mut cmd = CommandBuilder::new(if cfg!(windows) { "python" } else { "python3" });
    cmd.args(["-u", "-c", script, mode]);
    cmd.arg(base.path().join("shutdown-child.pid"));
    cmd.arg(fake_token());
    let live = ClaudePaths { credentials: base.path().join("must-not-read-credentials"),
        claude_json: base.path().join("missing-config"), store: CredentialStore::File };
    (base, cmd, live)
}

// Like the existing fake-CLI tests, shutdown tests that spawn a real child through the PTY run on Unix only.
#[cfg(unix)]
fn run_shutdown_waiting_cli(mode: &str) -> tempfile::TempDir {
    let (base, cmd, live) = shutdown_fixture(mode);
    let registry = Arc::new(SetupTokenRegistry::default());
    let (initial, control) = registry.begin(ID).unwrap();
    let (url_tx, url_rx) = mpsc::sync_channel(1);
    let (cleanup_tx, cleanup_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let registry_worker = registry.clone();
    let worker = std::thread::spawn(move || {
        let store = MemoryStore::default();
        let cleanup_count = std::cell::Cell::new(0);
        let mut events = Vec::new();
        let mut url_sent = false;
        let audit = run_attempt(&registry_worker, initial, control, base.path(), &live, cmd,
            RunOptions { timeout: Duration::from_secs(20), ..RunOptions::default() },
            &store, |_| panic!("waiting fixture must not check an owner"), |path| {
                cleanup_count.set(cleanup_count.get() + 1);
                cleanup_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                staging::cleanup_staging_with_credentials(path, &NoCredentials);
            }, |event| {
                if event.url.is_some() && !url_sent { url_sent = true; url_tx.send(()).unwrap(); }
                events.push(event);
            });
        (base, audit, cleanup_count.get(), events, store.0.into_inner())
    });
    url_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    registry.close_for_exit();
    registry.close_for_exit();
    cleanup_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    // Cleanup is part of the active attempt, even after its child has stopped.
    assert_eq!(registry.wait_idle(Instant::now() + Duration::from_millis(30)), SetupShutdown::TimedOut);
    let entered = registry.wait_entries.load(Ordering::SeqCst);
    let result = std::thread::scope(|scope| {
        let registry = &registry;
        scope.spawn(move || {
            // Release cleanup only after wait_idle enters its Condvar wait.
            let deadline = Instant::now() + Duration::from_secs(5);
            while registry.wait_entries.load(Ordering::SeqCst) <= entered {
                if Instant::now() >= deadline {
                    release_tx.send(()).unwrap();
                    panic!("wait_idle did not enter its Condvar wait within 5s");
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            release_tx.send(()).unwrap();
        });
        registry.wait_idle(Instant::now() + Duration::from_secs(3))
    });
    let (base, audit, cleanup_count, events, secrets) = worker.join().unwrap();
    assert_eq!(result, SetupShutdown::Finished);
    assert!(audit.child_stopped);
    assert_eq!(cleanup_count, 1);
    let terminal: Vec<_> = events.iter().filter(|event| event.state.terminal()).collect();
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0].state, SetupTokenState::Cancelled);
    assert_eq!(terminal[0].reason.as_deref(), Some("cancelled"));
    assert!(secrets.is_empty());
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
    assert!(audit.wiped_buffer.iter().all(|byte| *byte == 0));
    base
}

#[cfg(unix)]
#[test]
fn setup_token_shutdown_waits_for_child_cleanup_and_one_cancelled_event() {
    let _base = run_shutdown_waiting_cli("wait");
}

#[test]
fn setup_token_shutdown_rejects_new_attempts_and_never_spawns_a_pending_child() {
    let (base, cmd, live) = shutdown_fixture("wait");
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    registry.close_for_exit();
    registry.close_for_exit();
    assert!(matches!(registry.begin(ID), Err(reason) if reason == "cli_account.error.setup_already_running"));
    let store = MemoryStore::default();
    let audit = run_attempt(&registry, initial, control, base.path(), &live, cmd, RunOptions::default(), &store,
        |_| panic!("must not check an owner"), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
    assert!(audit.child_stopped);
    assert!(!base.path().join("shutdown-child.pid").exists());
    assert!(store.0.borrow().is_empty());
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::Cancelled);
    assert!(matches!(registry.begin(ID), Err(reason) if reason == "cli_account.error.setup_already_running"));
    let empty = SetupTokenRegistry::default();
    empty.close_for_exit();
    assert!(empty.begin(ID).is_err());
}

#[test]
fn setup_token_shutdown_idle_returns_immediately_even_after_the_deadline() {
    let registry = SetupTokenRegistry::default();
    let started = Instant::now();
    assert_eq!(registry.wait_idle(started + Duration::from_secs(3)), SetupShutdown::Idle);
    registry.close_for_exit();
    assert_eq!(registry.wait_idle(started), SetupShutdown::Idle);
    assert!(started.elapsed() < Duration::from_millis(50));
}

#[cfg(unix)]
#[test]
fn setup_token_shutdown_times_out_during_owner_lookup_then_cleans_once() {
    let (base, cmd, live) = shutdown_fixture("success");
    let registry = Arc::new(SetupTokenRegistry::default());
    let (initial, control) = registry.begin(ID).unwrap();
    let registry_worker = registry.clone();
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        let store = MemoryStore::default();
        let cleanup_count = std::cell::Cell::new(0);
        let audit = run_attempt(&registry_worker, initial, control, base.path(), &live, cmd,
            RunOptions::default(), &store, |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                owner(false)
            }, |path| {
                cleanup_count.set(cleanup_count.get() + 1);
                staging::cleanup_staging_with_credentials(path, &NoCredentials);
            }, |_| {});
        (base, audit, cleanup_count.get(), store.0.into_inner())
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    registry.close_for_exit();
    let started = Instant::now();
    let result = registry.wait_idle(started + Duration::from_millis(300));
    let elapsed = started.elapsed();
    release_tx.send(()).unwrap();
    let (base, audit, cleanup_count, secrets) = worker.join().unwrap();
    assert_eq!(result, SetupShutdown::TimedOut);
    assert!(elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(1), "deadline: {elapsed:?}");
    assert!(audit.child_stopped);
    assert_eq!(cleanup_count, 1);
    assert!(secrets.is_empty());
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::Cancelled);
    assert_eq!(registry.wait_idle(Instant::now()), SetupShutdown::Idle);
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn setup_token_shutdown_does_not_cancel_or_interrupt_a_commit_in_progress() {
    struct BlockingStore {
        memory: MemoryStore,
        entered: SyncSender<()>,
        release: Receiver<()>,
    }
    impl LaunchTokenStore for BlockingStore {
        fn read(&self, id: &str) -> Result<Option<String>, String> { self.memory.read(id) }
        fn write(&self, id: &str, value: &str) -> Result<(), String> {
            self.entered.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(10)).unwrap();
            self.memory.write(id, value)
        }
        fn delete(&self, id: &str) -> Result<(), String> { self.memory.delete(id) }
    }
    let (base, cmd, live) = shutdown_fixture("success");
    let registry = Arc::new(SetupTokenRegistry::default());
    let (initial, control) = registry.begin(ID).unwrap();
    let cancelled = control.cancelled.clone();
    let registry_worker = registry.clone();
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        let store = BlockingStore { memory: MemoryStore::default(), entered: entered_tx, release: release_rx };
        let cleanup_count = std::cell::Cell::new(0);
        let audit = run_attempt(&registry_worker, initial, control, base.path(), &live, cmd,
            RunOptions::default(), &store, |_| owner(false), |path| {
                cleanup_count.set(cleanup_count.get() + 1);
                staging::cleanup_staging_with_credentials(path, &NoCredentials);
            }, |_| {});
        (base, audit, cleanup_count.get(), store.memory.0.into_inner().len())
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let started = Instant::now();
    registry.close_for_exit();
    registry.close_for_exit();
    assert!(started.elapsed() < Duration::from_millis(50), "shutdown must not wait for storage I/O");
    assert!(!cancelled.load(Ordering::SeqCst));
    let started = Instant::now();
    let result = registry.wait_idle(started + Duration::from_millis(300));
    let elapsed = started.elapsed();
    release_tx.send(()).unwrap();
    let (base, audit, cleanup_count, saved) = worker.join().unwrap();
    assert_eq!(result, SetupShutdown::TimedOut);
    assert!(elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(1), "deadline: {elapsed:?}");
    assert!(audit.child_stopped);
    assert_eq!(cleanup_count, 1);
    assert_eq!(saved, 1);
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::Saved);
    assert_eq!(registry.wait_idle(Instant::now()), SetupShutdown::Idle);
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn setup_token_shutdown_stops_the_same_process_group_grandchild() {
    let base = run_shutdown_waiting_cli("descendant");
    let pid: i32 = fs::read_to_string(base.path().join("shutdown-child.pid.grandchild")).unwrap().trim().parse().unwrap();
    assert!(pid > 1);
    // A killed orphan can briefly remain as a zombie; it must never be live.
    let status = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    let state = String::from_utf8(status.stdout).unwrap();
    assert!(state.trim().is_empty() || state.trim().starts_with('Z'), "grandchild must be stopped");
}
