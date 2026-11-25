use super::*;
use crate::cli_accounts::{registry, CliAccountProfile, CliProvider,
    claude::{ClaudePaths, CredentialStore}};
#[cfg(any(unix, windows))]
use crate::cli_accounts::token_owner::{OwnerCheck, TokenOwner};
use std::{cell::RefCell, collections::HashMap, fs};
#[cfg(windows)]
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
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

// The existing capture tests assert the outward failure codes.
fn capture_complete(raw: &SecretBytes) -> Result<SecretBytes, CaptureFailure> {
    super::capture_complete(raw, &mut Screen::default()).map_err(FailureReason::outcome)
}

fn drain_output(receiver: &Receiver<PtyOutput>, raw: &mut SecretBytes, timeout: Duration) -> Result<(), CaptureFailure> {
    let mut received_bytes = raw.0.len();
    super::drain_output(receiver, raw, timeout, &mut received_bytes).map_err(FailureReason::outcome)
}

fn capture_screen(raw: &[u8]) -> Option<SecretBytes> {
    capture_complete(&SecretBytes(raw.to_vec())).ok()
}

fn capture_text_rows(text: &[u8]) -> Option<SecretBytes> {
    let mut raw = SecretBytes(Vec::with_capacity(text.len() * 2));
    for &byte in text {
        if byte == b'\n' { raw.0.push(b'\r'); }
        raw.0.push(byte);
    }
    capture_complete(&raw).ok()
}
#[cfg(unix)]
fn fixture_token(base: &Path) -> String {
    let seed: String = base.file_name().unwrap().to_string_lossy().chars().filter(char::is_ascii_alphanumeric).collect();
    format!("sk-ant-oat01-{}", seed.chars().cycle().take(95).collect::<String>())
}
#[cfg(any(unix, windows))]
fn owner(mismatch: bool) -> LaunchOwnerCheck {
    OwnerCheck::Owner(TokenOwner { account_uuid: if mismatch { "other" } else { "owner-1" }.into(),
        email: None, organization_uuid: None }).into()
}

#[test]
fn setup_token_parser_requires_a_single_complete_standalone_line_after_the_marker() {
    let token = fake_token();
    let good = format!("Your OAuth token:\n  {token}  \n");
    assert_eq!(capture_text_rows(good.as_bytes()).unwrap().as_slice(), token.as_bytes());
    for bad in [
        format!("{token}\n"), format!("{token}\nOAuth token\n"), format!("OAuth token\nprefix {token}\n"),
        format!("OAuth token\n{token} suffix\n"), format!("OAuth token\n{token}\n{token}b\n"),
        format!("OAuth token\n{}\n{}\n", &token[..50], &token[50..]),
    ] { assert!(capture_text_rows(bad.as_bytes()).is_none(), "reject ambiguous or incomplete output"); }
    let at_exit = format!("OAuth token\n{token}");
    assert_eq!(capture_text_rows(at_exit.as_bytes()).unwrap().as_slice(), token.as_bytes());
}
#[test]
fn setup_token_removes_ansi_even_inside_the_token_and_hides_unsafe_urls() {
    let token = fake_token();
    let raw = format!("\x1b]0;private title\x07\x1b[32mOAuth token\x1b[0m\r\n{}\x1b[33m{}\x1b[0m\r\n", &token[..30], &token[30..]);
    assert_eq!(capture_screen(raw.as_bytes()).unwrap().as_slice(), token.as_bytes());
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

#[test]
fn setup_token_reader_wipes_the_buffer_before_each_read_with_or_without_capture() {
    struct CheckedReads { read: usize, capture: bool }
    impl Read for CheckedReads {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            assert!(buffer.iter().all(|byte| *byte == 0),
                "capture={}, read={}", self.capture, self.read);
            let count = [17, 3, 0][self.read];
            buffer[..count].fill(b'x');
            self.read += 1;
            Ok(count)
        }
    }
    for capture in [true, false] {
        let (sender, receiver) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
        let receiver = capture.then_some(receiver);
        read_pty_output(CheckedReads { read: 0, capture }, sender, &AtomicBool::new(false));
        if let Some(receiver) = receiver {
            for count in [17, 3] {
                let PtyOutput::Data(chunk) = receiver.recv().unwrap() else { panic!("data expected"); };
                assert_eq!(chunk.as_slice(), vec![b'x'; count].as_slice());
            }
            assert!(matches!(receiver.recv(), Ok(PtyOutput::Eof)));
        }
    }
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
if mode == 'browser_before_code':
    tty.setraw(0)
    while not os.path.exists(report + '.approved'): time.sleep(0.01)
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
        screen = '\033[4;1H\033[2KYour OAuth token (valid for 1 year):\033[5;1H' + token + '\033[B'
        os.write(1, (screen + screen).encode())
    elif mode != 'no_marker': print('\033[1mYour OAuth token:\033[0m', flush=True)
    if mode == 'conpty': pass
    elif mode == 'cursor_visibility_eof': os.write(1, token[:50].encode() + b'\033[?25h')
    elif mode == 'overwrite_last_byte': os.write(1, token.encode() + b'\033[Dz\n')
    elif mode == 'erase_display_eof': os.write(1, token[:50].encode() + b'\033[0J')
    elif mode == 'same_row_eof': os.write(1, b'\033[5;1H' + token[:50].encode() + b'\033[5;1H')
    elif mode == 'normal_crlf': os.write(1, token.encode() + b'\r\n')
    elif mode == 'extra': print('prefix ' + token, flush=True)
    elif mode == 'two':
        print(token, flush=True); time.sleep(0.04); print(token + 'b', flush=True)
    elif mode == 'wrapped': print(token[:50] + '\n' + token[50:], flush=True)
    elif mode == 'ansi_split':
        os.write(1, token[:30].encode()); os.write(1, b'\033[33m'); os.write(1, token[30:].encode() + b'\033[0m\n')
    else: print(token, flush=True)
    if mode == 'partial_wrap': sys.stdout.write('abcdef'); sys.stdout.flush()
    if mode == 'unreadable_after_candidate': os.write(1, b'\xff')
    if mode == 'partial_prefix': sys.stdout.write('sk-ant-'); sys.stdout.flush()
    if mode == 'heading_value': print('Your OAuth token: ' + token + 'b', flush=True)
    if mode == 'malformed_oauth_error':
        os.write(1, b'OAuth error: see https://example.test/oauth/authorize?state=fixture \xe3\x81')
    if mode == 'malformed_conflicting_token': os.write(1, token.encode() + b'b\xe3\x81')
    if mode == 'cr_error':
        os.write(1, b'Checking authorization...\rOAuth error: invalid grant\n')
    suffix = {{
        'short_prefix': b'sk',
        'short_prefix_invalid': b'sk\xe3\x81',
        'retry': b'Press Enter to retry.',
        'retry_invalid': b'Press Enter to retry.\xff',
        'retry_quoted': b'Press Enter to retry. (quoted)',
        'retry_quoted_invalid': b'Press Enter to retry. (quoted)\xff',
        'revoked': b'Anthropic reported the token revoked; it was not shown.',
        'revoked_invalid': b'Anthropic reported the token revoked; it was not shown.\xff',
        'revoked_quoted': b'Anthropic reported the token revoked; it was not shown. (quoted)',
        'revoked_quoted_invalid': b'Anthropic reported the token revoked; it was not shown.\xff (quoted)',
    }}.get(mode)
    if suffix is not None:
        os.write(1, b'Press Enter to continue.\n' + suffix)
    if mode == 'browser_before_code':
        open(report + '.screen', 'w').close()
        received = b''
        while not received.endswith(b'\r'): received += os.read(0, 4096)
        with open(report + '.input', 'wb') as f: f.write(received)
    if mode == 'natural_after_confirmation_error': time.sleep(0.5)
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
        RunOptions { timeout: Duration::from_secs(if mode == "timeout" { 2 } else { 20 }),
            token_exit_grace: Duration::from_millis(150), confirm_exit_grace: Duration::from_millis(150),
            fallback_after: Duration::from_millis(50) },
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
    for (start, end, adjacent) in [
        ("\x1b[5;1H", "\x1b[6;1H", false), ("\x1b[5;1f", "\x1b[6;1f", false),
        ("\x1b[B", "\x1b[B", true), ("\x1b[E", "\x1b[E", true),
        ("\x1b[5d", "\x1b[4d", false), ("\x1b[5d", "\x1b[A", false), ("\x1b[5d", "\x1b[F", false),
    ] {
        let output = format!("Your OAuth token:{start}{token}{end}");
        assert_eq!(capture_screen(output.as_bytes()).as_ref().map(SecretBytes::as_slice),
            adjacent.then_some(token.as_bytes()), "{start:?} {end:?}");
        let split = format!("OAuth token{start}{}{end}{}\n", &token[..50], &token[50..]);
        assert!(capture_screen(split.as_bytes()).is_none());
    }
}

#[test]
fn setup_token_line_edits_cannot_supply_a_candidate() {
    let token = fake_token();
    for edit in ["\x1b[C", "\x1b[D", "\x1b[G", "\x1b[1\x60",
        "\x1b[P", "\x1b[@", "\x1b[X", "\x08", "\r", "\x1b[5;1H", "\x1b[5;1f"] {
        let raw = format!("OAuth token\x1b[5;1H{token}{edit}z\n");
        assert!(capture_screen(raw.as_bytes()).is_none(), "{edit:?}");
    }
    let at_bottom = format!("OAuth token\x1b[40d{token}\x1b[B");
    assert!(capture_screen(at_bottom.as_bytes()).is_none());

    let corrupt = format!("Your OAuth token:\r\n{token}\x1b[D!");
    assert_eq!(setup_0915_final(&corrupt).as_deref(), None);
    let last_byte = &token[token.len() - 1..];
    let repaired = format!("{corrupt}\x1b[D{last_byte}\r\n");
    assert_eq!(setup_0915_final(repaired).as_deref(), Some(token.as_bytes()));
}
#[test]
fn setup_token_accepts_windows_conpty_startup_screen() {
    let token = fake_token();
    // Captured from Windows ConPTY in local_cmd_512x40.jsonl.bin.
    let raw = format!(
        concat!(
            "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[HYour OAuth token:\r\n",
            "{}\r\nPress Enter to continue.\x1b]0;C:\\Windows\\System32\\cmd.exe\x07",
            "\x1b[?25h\r\nconfirmed\r\n",
        ),
        token,
    );
    let extracted = capture_screen(raw.as_bytes()).expect("startup positioning must preserve the heading");
    assert_eq!(extracted.as_slice(), token.as_bytes());
}

#[test]
fn setup_token_accepts_same_row_positioning_before_text() {
    let token = fake_token();
    for (prefix, expected) in [
        ("\x1b[H\x1b[f", Some(token.as_bytes())),
        ("notice\r\n\x1b[2;1H\x1b[2;1f", Some(token.as_bytes())),
        ("notice\x1b[2;1H\x1b[2;1f", Some(token.as_bytes())),
    ] {
        let raw = format!("{prefix}Your OAuth token:\r\n{token}\r\n");
        let extracted = capture_screen(raw.as_bytes());
        assert_eq!(extracted.as_ref().map(SecretBytes::as_slice), expected, "{prefix:?}");
    }
}

#[test]
fn setup_token_rejects_same_row_rewrites_of_heading_or_candidate() {
    let token = fake_token();
    let raw = format!("Your \x1b[HOAuth token:\r\n{token}\r\n");
    assert_eq!(capture_screen(raw.as_bytes()).unwrap().as_slice(), token.as_bytes());

    let split = token.len() - 1;
    for position in ["\x1b[2;1H", "\x1b[2;1f"] {
        let raw = format!("Your OAuth token:\r\n{}{position}{}\r\n", &token[..split], &token[split..]);
        assert!(capture_screen(raw.as_bytes()).is_none(), "{position:?}");
    }
}

#[test]
fn setup_token_rejects_same_row_positioning_after_whitespace() {
    let token = fake_token();
    for whitespace in [' ', '\t'] {
        let raw = format!("{whitespace}\x1b[HYour OAuth token:\r\n{token}\r\n");
        assert_eq!(capture_screen(raw.as_bytes()).unwrap().as_slice(), token.as_bytes(), "{whitespace:?}");
    }
}

#[test]
fn setup_token_rejects_same_row_positioning_after_returning_to_written_row() {
    let token = fake_token();
    for (position, expected) in [
        ("\x1b[2;1H", Some(token.as_bytes())), ("\x1b[2;1f", Some(token.as_bytes())),
        ("\x1b[2;5H", None), ("\x1b[2;5f", None),
    ] {
        let raw = format!("Your OAuth token:\r\ntag:XX\r\n\x1b[A{position}{token}\r\n");
        assert_eq!(capture_screen(raw.as_bytes()).as_ref().map(SecretBytes::as_slice), expected, "{position:?}");
    }
}

#[test]
fn setup_token_rejects_same_row_positioning_after_moving_to_unwritten_row() {
    let token = fake_token();
    let expected: Option<&[u8]> = Some(token.as_bytes());
    for command in ['H', 'f'] {
        let raw = format!("notice\x1b[3d\x1b[A\x1b[2;1{command}Your OAuth token:\r\n{token}\r\n");
        assert_eq!(capture_screen(raw.as_bytes()).as_ref().map(SecretBytes::as_slice), expected, "{command:?}");
    }
}

#[test]
fn setup_token_rejects_same_row_positioning_after_whitespace_or_screen_clear() {
    let token = fake_token();
    for (prefix, row) in [
        (" ", ""), ("\t", ""),
        (" \r\n", "2;1"), ("\t\r\n", "2;1"),
        ("notice\x1b[2J", ""), ("notice\r\n\x1b[2J", "2;1"),
    ] {
        for command in ['H', 'f'] {
            let raw = format!("{prefix}\x1b[{row}{command}Your OAuth token:\r\n{token}\r\n");
            let extracted = capture_screen(raw.as_bytes());
            assert_eq!(extracted.as_ref().map(SecretBytes::as_slice), Some(token.as_bytes()), "{prefix:?} {row:?} {command}");
        }
    }
}

#[test]
fn setup_token_rejects_same_row_positioning_after_screen_movement() {
    let token = fake_token();
    let other_text = ".".repeat(token.len());
    let last_row = PTY_ROWS;
    let previous_row = last_row - 1;
    let tail_column = token.len() + 1;
    let mut accepted = Vec::new();
    for command in ['H', 'f'] {
        for (case, drawing, row) in [
            (
                "scroll at bottom row",
                format!("\x1b[{last_row};{tail_column}HZ\r\n\x1b[A"),
                previous_row,
            ),
            ("automatic wrap", format!("\x1b[5;512HP{other_text}Z\x1b[6d"), 6),
            ("next line escape", format!("\x1b[4;1H\x1bE{other_text}Z\x1b[5d"), 5),
        ] {
            let raw = format!(
                "\x1b[10;1HYour OAuth token:\r\n{drawing}\x1b[{row};1{command}{token}\r\n"
            );
            if capture_screen(raw.as_bytes()).is_some() {
                accepted.push((case, command));
            }
        }
    }
    assert!(accepted.is_empty(), "positioning after screen movement supplied a candidate: {accepted:?}");
}

#[test]
fn setup_token_rejects_same_row_positioning_before_edited_candidate() {
    let token = fake_token();
    let (first_half, second_half) = token.split_at(token.len() / 2);
    for (case, drawing, expected) in [
        ("line erase", format!("{first_half}\x1b[2K{second_half}\r\n"), None),
        (
            "overwritten continuation",
            format!("{token}\r\nCD\x1b[2K\x1b[GPress Enter to continue.\r\n"),
            Some(token.as_bytes()),
        ),
        (
            "later candidate rewrite",
            format!("{token}\r\nPress Enter to continue.\x1b[2;2HZ\r\n"),
            None,
        ),
    ] {
        for command in ['H', 'f'] {
            let raw = format!("Your OAuth token:\r\n\x1b[2;1{command}{drawing}");
            assert_eq!(capture_screen(raw.as_bytes()).as_ref().map(SecretBytes::as_slice),
                expected, "{case} {command:?}");
        }
    }
}

#[test]
fn setup_token_rejects_non_first_column_positioning_on_empty_row() {
    let token = fake_token();
    for (position, expected) in [
        ("\x1b[2;2H", Some(token.as_bytes())), ("\x1b[2;2f", Some(token.as_bytes())),
        ("\x1b[2;511H", None), ("\x1b[2;511f", None),
    ] {
        let raw = format!("Your OAuth token:\r\n{position}{token}\x1b[3;1H!\r\n");
        assert_eq!(capture_screen(raw.as_bytes()).as_ref().map(SecretBytes::as_slice), expected, "{position:?}");
    }
}

#[test]
fn setup_token_accepts_first_column_positioning_on_empty_first_row() {
    let token = fake_token();
    for position in ["\x1b[H", "\x1b[1;1H", "\x1b[;H"] {
        let raw = format!("{position}Your OAuth token:\r\n{token}\r\n");
        let extracted = capture_screen(raw.as_bytes()).expect("first-column positioning must preserve the heading");
        assert_eq!(extracted.as_slice(), token.as_bytes());
    }
}

#[test]
fn setup_token_repeated_identical_tokens_count_as_one_value() {
    let token = fake_token();
    let text = format!("OAuth token\n{token}\nOAuth token\n{token}\n");
    assert_eq!(capture_text_rows(text.as_bytes()).map(|v| v.as_slice().to_vec()), Some(token.as_bytes().to_vec()));
    assert!(capture_text_rows(format!("{text}{token}b\n").as_bytes()).is_none());
}
#[test]
fn setup_token_invalid_utf8_in_unrelated_lines_preserves_ascii_token_and_url() {
    let token = fake_token();
    let mut text = b"invalid \xff header\nhttps://example.test/oauth/authorize?state=fixture\nOAuth token\n".to_vec();
    text.extend_from_slice(format!("{token}\n").as_bytes());
    assert_eq!(authorization_url(&text).as_deref(), Some("https://example.test/oauth/authorize?state=fixture"));
    assert_eq!(capture_text_rows(&text).map(|v| v.as_slice().to_vec()), Some(token.as_bytes().to_vec()));
}
#[test]
fn setup_token_esc_intermediates_and_final_byte_do_not_leak_into_text() {
    let token = fake_token();
    let text = format!("\x1b(BYour OAuth token:\n\x1b( B{token}\n");
    let plain = strip_controls(text.as_bytes());
    assert_eq!(plain.as_slice(), format!("Your OAuth token:\n{token}\n").as_bytes());
    assert!(capture_text_rows(plain.as_slice()).is_some());
    assert!(capture_screen(text.as_bytes()).is_none());
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
    assert!(sender.send(PtyOutput::Data(SecretBytes(b"fixture output".to_vec()))).is_ok());
    let mut raw = SecretBytes(Vec::with_capacity(OUTPUT_LIMIT));
    let start = Instant::now();
    assert_eq!(drain_output(&receiver, &mut raw, Duration::from_millis(30)), Err(CaptureFailure::CaptureFailed));
    assert!(start.elapsed() < Duration::from_millis(300));
    assert_eq!(raw.as_slice(), b"fixture output");
    raw.wipe();
    assert!(raw.0.iter().all(|byte| *byte == 0));
    drop(sender);
}

#[test]
fn setup_token_drain_timeout_never_accepts_an_observed_token() {
    let complete = format!("Your OAuth token:\n{}\n", fake_token());
    let different = format!("sk-ant-oat01-{}", "b".repeat(95));
    for (tail, expected) in [
        ("Finishing setup.\n".to_owned(), Err(CaptureFailure::CaptureFailed)),
        (complete.clone(), Err(CaptureFailure::CaptureFailed)),
        ("OAuth error: authorization was revoked\n".to_owned(), Err(CaptureFailure::CaptureFailed)),
        (format!("{different}\n"), Err(CaptureFailure::CaptureFailed)),
        (different, Err(CaptureFailure::CaptureFailed)),
        (" ".repeat(OUTPUT_LIMIT), Err(CaptureFailure::OutputLimit)),
    ] {
        let mut raw = SecretBytes(complete.as_bytes().to_vec());
        let (sender, receiver) = mpsc::sync_channel(1);
        assert!(sender.send(PtyOutput::Data(SecretBytes(tail.into_bytes()))).is_ok());
        let drain = drain_output(&receiver, &mut raw, Duration::from_millis(10));
        assert_eq!(drain.and_then(|()| capture_complete(&raw)).map(|_| ()), expected);
        drop(sender);
    }
}

#[test]
fn setup_token_drain_requires_an_explicit_eof_from_the_reader() {
    for end in [Some(PtyOutput::Eof), Some(PtyOutput::ReadFailed), None] {
        let expected = if matches!(&end, Some(PtyOutput::Eof)) { Ok(()) } else { Err(CaptureFailure::CaptureFailed) };
        let (sender, receiver) = mpsc::sync_channel(1);
        if let Some(end) = end { assert!(sender.send(end).is_ok()); }
        drop(sender);
        assert_eq!(drain_output(&receiver, &mut SecretBytes(Vec::new()), Duration::from_secs(1)), expected);
    }
}

#[test]
fn setup_token_drain_checks_queued_output_at_the_deadline() {
    let (sender, receiver) = mpsc::sync_channel(2);
    let mut raw = SecretBytes(vec![b'a'; OUTPUT_LIMIT - 8]);
    assert!(sender.send(PtyOutput::Data(SecretBytes(b"late".to_vec()))).is_ok());
    assert!(sender.send(PtyOutput::Data(SecretBytes(b"overflow".to_vec()))).is_ok());
    assert_eq!(drain_output(&receiver, &mut raw, Duration::ZERO), Err(CaptureFailure::OutputLimit));
    assert!(raw.as_slice().ends_with(b"late"));
    assert!(receiver.try_recv().is_err());
}

#[test]
fn setup_token_oauth_error_with_url_is_not_an_authorization_link() {
    let url = "https://example.test/oauth/authorize?state=OAuth%20error%3A";
    assert!(cli_error(format!("OAuth error: see {url}").as_bytes()));
    let authorization = format!("Open {url}");
    assert!(!cli_error(authorization.as_bytes()));
    assert_eq!(authorization_url(authorization.as_bytes()).as_deref(), Some(url));
}

#[cfg(unix)]
#[test]
fn setup_token_incomplete_or_conflicting_eof_does_not_replace_saved_value() {
    for mode in ["partial_wrap", "partial_prefix", "heading_value"] {
        let (base, cmd, live) = fixture(mode);
        let store = MemoryStore::default();
        store.write(ID, &fake_token()).unwrap();
        let registry = SetupTokenRegistry::default();
        let (initial, control) = registry.begin(ID).unwrap();
        run_attempt(&registry, initial, control, base.path(), &live, cmd, RunOptions::default(),
            &store, |_| owner(false), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
        let event = registry.current().unwrap().unwrap();
        if mode == "heading_value" {
            assert_eq!(event.state, SetupTokenState::Saved, "{mode}");
            assert!(store.read(ID).unwrap().as_deref() == Some(fixture_token(base.path()).as_str()));
        } else {
            assert_eq!(event.state, SetupTokenState::Failed, "{mode}");
            assert_eq!(event.reason.as_deref(), Some("capture_failed"));
            assert_eq!(store.read(ID).unwrap().as_deref(), Some(fake_token().as_str()));
        }
    }
}

#[cfg(unix)]
#[test]
fn setup_token_cursor_visibility_does_not_complete_a_candidate_but_conpty_redraw_does() {
    for (mode, expected) in [
        ("cursor_visibility_eof", SetupTokenState::Saved),
        ("conpty", SetupTokenState::Saved),
    ] {
        let (base, cmd, live) = fixture(mode);
        let store = MemoryStore::default();
        store.write(ID, &fake_token()).unwrap();
        let registry = SetupTokenRegistry::default();
        let (initial, control) = registry.begin(ID).unwrap();
        run_attempt(&registry, initial, control, base.path(), &live, cmd, RunOptions::default(),
            &store, |_| owner(false), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
        assert_eq!(registry.current().unwrap().unwrap().state, expected, "{mode}");
        let saved = expected_fixture_value(base.path(), mode);
        assert!(store.read(ID).unwrap().as_deref() == Some(saved.as_str()), "{mode}");
    }
}

#[cfg(unix)]
fn expected_fixture_value(base: &Path, mode: &str) -> String {
    let mut token = fixture_token(base);
    match mode {
        "cursor_visibility_eof" | "erase_display_eof" => token.truncate(50),
        "overwrite_last_byte" => {
            token.pop();
            token.push('z');
        }
        _ => {}
    }
    token
}

#[cfg(unix)]
fn assert_setup_token_fixture_decisions(cases: &[(&str, Option<&str>)]) {
    let mut differences = Vec::new();
    for &(mode, expected_reason) in cases {
        let (base, cmd, live) = fixture(mode);
        let store = MemoryStore::default();
        let previous = fake_token();
        store.write(ID, &previous).unwrap();
        let registry = SetupTokenRegistry::default();
        let (initial, control) = registry.begin(ID).unwrap();
        let owner_checks = std::cell::Cell::new(0);
        run_attempt(&registry, initial, control, base.path(), &live, cmd, RunOptions::default(),
            &store, |_| { owner_checks.set(owner_checks.get() + 1); owner(false) },
            |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
        let event = registry.current().unwrap().unwrap();
        let saved = expected_reason.is_none();
        let expected_state = if saved { SetupTokenState::Saved } else { SetupTokenState::Failed };
        let expected_value = if saved { expected_fixture_value(base.path(), mode) } else { previous };
        let value_matches = store.read(ID).unwrap().as_deref() == Some(expected_value.as_str());
        if event.state != expected_state || event.reason.as_deref() != expected_reason
            || owner_checks.get() != usize::from(saved) || !value_matches
        {
            differences.push((mode, event.state, event.reason, owner_checks.get(), value_matches));
        }
    }
    assert!(differences.is_empty(), "case, state, reason, owner checks, expected store value: {differences:?}");
}

#[cfg(unix)]
#[test]
fn setup_token_requires_a_real_row_boundary_and_an_unedited_candidate() {
    assert_setup_token_fixture_decisions(&[
        ("overwrite_last_byte", None),
        ("erase_display_eof", None),
        ("same_row_eof", Some("capture_failed")),
        ("conpty", None),
    ]);
}

#[cfg(unix)]
#[test]
fn setup_token_matches_errors_after_cr_and_accepts_crlf_tokens() {
    assert_setup_token_fixture_decisions(&[("cr_error", Some("cli_error")), ("normal_crlf", None)]);
}

#[cfg(unix)]
#[test]
fn setup_token_applies_the_same_rules_to_readable_and_malformed_lines() {
    assert_setup_token_fixture_decisions(&[
        ("short_prefix", Some("capture_failed")), ("short_prefix_invalid", Some("capture_failed")),
        ("unreadable_after_candidate", Some("capture_failed")),
        ("retry", Some("cli_error")), ("retry_invalid", Some("cli_error")),
        ("retry_quoted", None), ("retry_quoted_invalid", None),
        ("revoked", Some("cli_error")), ("revoked_invalid", Some("cli_error")),
        ("revoked_quoted", None), ("revoked_quoted_invalid", None),
    ]);
}

#[cfg(unix)]
#[test]
fn setup_token_malformed_relevant_output_does_not_replace_saved_value() {
    for (mode, expected_reason) in [
        ("malformed_oauth_error", Some("cli_error")),
        ("malformed_conflicting_token", Some("capture_failed")),
        ("invalid_utf8", None),
    ] {
        let (base, cmd, live) = fixture(mode);
        let store = MemoryStore::default();
        store.write(ID, &fake_token()).unwrap();
        let registry = SetupTokenRegistry::default();
        let (initial, control) = registry.begin(ID).unwrap();
        let owner_checked = std::cell::Cell::new(false);
        run_attempt(&registry, initial, control, base.path(), &live, cmd, RunOptions::default(),
            &store, |_| { owner_checked.set(true); owner(false) },
            |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
        let event = registry.current().unwrap().unwrap();
        assert_eq!(event.reason.as_deref(), expected_reason, "{mode}");
        let (state, saved) = if expected_reason.is_some() {
            (SetupTokenState::Failed, fake_token())
        } else {
            (SetupTokenState::Saved, fixture_token(base.path()))
        };
        assert_eq!(event.state, state, "{mode}");
        assert_eq!(owner_checked.get(), state == SetupTokenState::Saved, "{mode}");
        assert!(store.read(ID).unwrap().as_deref() == Some(saved.as_str()), "{mode}");
    }
}

#[cfg(unix)]
#[test]
fn setup_token_browser_success_discards_a_queued_code_and_sends_only_confirmation() {
    let (base, cmd, live) = fixture("browser_before_code");
    let store = MemoryStore::default();
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    run_attempt(&registry, initial, control, base.path(), &live, cmd,
        RunOptions { timeout: Duration::from_secs(10), fallback_after: Duration::ZERO,
            token_exit_grace: Duration::from_millis(200), confirm_exit_grace: Duration::from_secs(1) },
        &store, |_| owner(false), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials),
        |event| {
            let report = base.path().join("report.json");
            if event.state == SetupTokenState::CodeAvailable && !report.with_extension("json.approved").exists() {
                registry.submit_code(&event.login_id, "fixture-code#fixture-state".into()).unwrap();
                fs::write(report.with_extension("json.approved"), b"").unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !report.with_extension("json.screen").is_file() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                }
                assert!(report.with_extension("json.screen").is_file());
            }
        });
    assert_eq!(fs::read(base.path().join("report.json.input")).unwrap().as_slice(), b"\r");
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::Saved);
}

#[cfg(unix)]
#[test]
fn setup_token_failed_confirmation_requires_a_clean_natural_exit() {
    struct RejectInput { _writer: Box<dyn Write + Send> }
    impl Write for RejectInput {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    for (mode, expected) in [("linger", SetupTokenState::Failed),
        ("natural_after_confirmation_error", SetupTokenState::Saved)] {
        let (base, cmd, live) = fixture(mode);
        let registry = SetupTokenRegistry::default();
        let (initial, control) = registry.begin(ID).unwrap();
        let store = MemoryStore::default();
        store.write(ID, &fake_token()).unwrap();
        run_attempt_with_pty(&registry, initial, control, base.path(), &live, cmd,
            RunOptions { token_exit_grace: Duration::ZERO, confirm_exit_grace: Duration::from_secs(1), ..RunOptions::default() },
            &store, |_| owner(false), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {},
            |pty| {
                let writer = std::mem::replace(&mut pty.writer, Box::new(std::io::sink()));
                pty.writer = Box::new(RejectInput { _writer: writer });
            }, drop);
        let event = registry.current().unwrap().unwrap();
        assert_eq!(event.state, expected, "{mode}");
        if expected == SetupTokenState::Failed {
            assert_eq!(event.reason.as_deref(), Some("capture_failed"));
            assert_eq!(store.read(ID).unwrap().as_deref(), Some(fake_token().as_str()));
        } else {
            assert_eq!(store.read(ID).unwrap().as_deref(), Some(fixture_token(base.path()).as_str()));
        }
    }
}

#[test]
fn setup_token_read_loop_closes_code_input_before_drain_and_owner_lookup() {
    let registry = SetupTokenRegistry::default();
    let (initial, _control) = registry.begin(ID).unwrap();
    registry.publish(&initial.login_id, SetupTokenState::CodeAvailable, None, None, None);
    let _ = registry.close_input(&initial.login_id);
    assert_eq!(registry.submit_code(&initial.login_id, "fixture-code#fixture-state".into()), Err(UNAVAILABLE.into()));
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::CodeAvailable);
    registry.cancel(&initial.login_id).unwrap();
}

#[test]
fn setup_token_trailing_erase_does_not_complete_a_token_fragment() {
    let token = fake_token();
    let output = format!("Your OAuth token:\n{}\x1b[K", &token[..50]);
    assert_eq!(capture_screen(output.as_bytes()).unwrap().as_slice(), &token.as_bytes()[..50]);
}
#[test]
fn setup_token_unfinished_csi_does_not_complete_a_token_fragment() {
    let token = fake_token();
    for tail in ["\x1b[", "\x1b[12;"] {
        let output = format!("Your OAuth token:\n{}{tail}", &token[..50]);
        assert!(capture_screen(output.as_bytes()).is_none());
    }
}
#[test]
fn setup_token_redrawn_heading_does_not_hide_a_wrapped_continuation() {
    let token = fake_token();
    let output = format!("Your OAuth token:\n{}\nYour OAuth token:\n{}\n", &token[..50], &token[50..]);
    assert_eq!(capture_text_rows(output.as_bytes()).unwrap().as_slice(), &token.as_bytes()[..50]);
    let redraw = format!("Your OAuth token:\n{token}\nYour OAuth token:\n{token}\n");
    assert_eq!(capture_text_rows(redraw.as_bytes()).unwrap().as_slice(), token.as_bytes());
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
    let audit = run_attempt_with_pty(&registry, initial, control, base.path(), &live, cmd, RunOptions::default(),
        &MemoryStore::default(), |_| panic!("no token"), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials),
        |event| events.push(event), |_| {}, move |pty| {
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


fn write_fixture_profile(base: &Path) {
    let profile = CliAccountProfile { id: ID.into(), provider: CliProvider::Claude, label: "fixture".into(),
        email: None, identity_key: "owner-1".into(), plan: None, org_name: None, captured_at: String::new(),
        last_switched_at: None, needs_relogin: false, refresh_rejected_at: None, foreign_token_owner: None };
    registry::save(base, &registry::CliAccountsFile { profiles: vec![profile], ..Default::default() }).unwrap();
}

// The shutdown fixtures use the same isolated profile and in-memory secret store
// as the existing PTY tests, with Python invoked directly on either platform.
fn shutdown_fixture(mode: &str) -> (tempfile::TempDir, CommandBuilder, ClaudePaths) {
    let base = tempfile::tempdir().unwrap();
    write_fixture_profile(base.path());
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

#[cfg(windows)]
const WINDOWS_FIXTURE_SYNC_TIMEOUT: Duration = Duration::from_secs(45);

#[cfg(windows)]
fn wait_for_windows_fixture(deadline: Instant, description: &str, mut ready: impl FnMut() -> bool) {
    while !ready() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for {description}");
        std::thread::sleep(POLL_INTERVAL.min(remaining));
    }
}

#[cfg(windows)]
fn wait_for_windows_fixture_file(base: &Path, name: &str, deadline: Instant) {
    let path = base.join(name);
    wait_for_windows_fixture(deadline, name, || path.is_file());
}

#[cfg(windows)]
fn run_windows_cmd_fixture(
    mode: &str,
    prepare_pty: impl FnOnce(&Path, &mut PrivatePty),
    close_pty: impl FnOnce(PrivatePty) + Send + 'static,
) -> (tempfile::TempDir, SetupTokenEvent, MemoryStore, RunAudit, usize) {
    let base = tempfile::tempdir().unwrap();
    write_fixture_profile(base.path());
    let launcher = base.path().join("fixture-claude.cmd");
    fs::write(&launcher, concat!(
        "@echo off\r\n",
        "if not \"%FIXTURE_MODE:~0,8%\"==\"wrapper_\" goto foreground\r\n",
        "start \"\" /b python.exe -I -B -u \"%~dp0fixture.py\" %*\r\n",
        "if errorlevel 1 exit /b 1\r\n",
        "if not \"%FIXTURE_MODE%\"==\"wrapper_between_polls\" goto wrapper_exit\r\n",
        ":wait_for_failed_write\r\n",
        "if not exist \"%~dp0confirm-failed\" goto wait_for_failed_write\r\n",
        ":wrapper_exit\r\n",
        "type nul > \"%~dp0wrapper-exiting\" || exit /b 1\r\n",
        "exit /b 0\r\n",
        ":foreground\r\n",
        "python.exe -I -B -u \"%~dp0fixture.py\" %*\r\n",
        "exit /b %ERRORLEVEL%\r\n",
    )).unwrap();
    fs::write(base.path().join("fixture.py"), r#"
import msvcrt, os, pathlib, sys, threading, time

assert sys.argv[1:] == ['setup-token']
fixture_dir = pathlib.Path(__file__).parent
mode = os.environ['FIXTURE_MODE']
watchdog = threading.Timer(int(os.environ['FIXTURE_WATCHDOG_SECONDS']), lambda: os._exit(2))
watchdog.daemon = True
watchdog.start()
# Publish a complete PID as the CLI readiness signal.
pid_file = fixture_dir / 'child.pid'
pending = pid_file.with_suffix('.tmp')
pending.write_text(str(os.getpid()), encoding='ascii')
pending.rename(pid_file)
if mode == 'overflow_during_close':
    # Scroll well beyond the capture limit and the output pipe's capacity.
    block = ('0123456789' * 48 + '\n') * 128
    for _ in range(128):
        print(block, end='', flush=True)
    time.sleep(12)
print('Your OAuth token:\nsk-ant-oat01-' + 'a' * 95 + '\nPress Enter to continue.', flush=True)
if mode in ('wrapper_confirmation_fails', 'wrapper_between_polls'):
    while not (fixture_dir / 'let-cli-exit').exists():
        time.sleep(0.01)
    sys.exit(7)
while msvcrt.getwch() != '\r':
    pass
(fixture_dir / 'confirmed').touch()
if os.environ['FIXTURE_MODE'] in ('linger', 'wrapper_exits'):
    time.sleep(12)
"#).unwrap();
    let mut args = vec!["setup-token".to_owned()];
    let exe = crate::commands::terminal::prepare_spawn_command(launcher.to_str().unwrap(), &mut args);
    let mut command = CommandBuilder::new(exe);
    command.args(args);
    let wrapper_mode = mode.starts_with("wrapper_");
    let timeout = Duration::from_secs(if wrapper_mode { 60 } else { 10 });
    command.env("FIXTURE_MODE", mode);
    command.env("FIXTURE_WATCHDOG_SECONDS", (timeout.as_secs() + 2).to_string());
    let live = ClaudePaths { credentials: base.path().join("must-not-read-credentials"),
        claude_json: base.path().join("missing-config"), store: CredentialStore::File };
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let store = MemoryStore::default();
    store.write(ID, &previous_windows_fixture_value()).unwrap();
    let owner_checks = std::cell::Cell::new(0);
    let mut events = Vec::new();
    // Use one fixture deadline for launch and both exit gates. Leave time for capture
    // and cleanup even if the wrapper or CLI is scheduled late.
    let fixture_deadline = Instant::now() + WINDOWS_FIXTURE_SYNC_TIMEOUT;
    let audit = run_attempt_with_pty(&registry, initial, control, base.path(), &live, command,
        RunOptions { timeout, token_exit_grace: Duration::from_millis(200),
            confirm_exit_grace: Duration::from_secs(1), ..RunOptions::default() },
        &store, |_| { owner_checks.set(owner_checks.get() + 1); owner(false) }, |path| staging::cleanup_staging_with_credentials(path, &NoCredentials),
        |event| {
            if mode == "cancel_pending" && event.state == SetupTokenState::Confirming {
                registry.cancel(&event.login_id).unwrap();
            }
            events.push(event);
        }, |pty| {
            if wrapper_mode {
                prepare_windows_wrapper_fixture(base.path(), pty, mode, fixture_deadline);
            }
            prepare_pty(base.path(), pty);
        }, close_pty);
    (base, events.pop().unwrap(), store, audit, owner_checks.get())
}

#[cfg(windows)]
fn previous_windows_fixture_value() -> String { format!("sk-ant-oat01-{}", "b".repeat(95)) }

#[cfg(windows)]
fn query_windows_job_counts(handle: BorrowedHandle<'_>) -> (u32, u32) {
    use windows::Win32::{
        Foundation::HANDLE,
        System::JobObjects::{JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION},
    };

    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    unsafe {
        QueryInformationJobObject(HANDLE(handle.as_raw_handle()), JobObjectBasicAccountingInformation,
            std::ptr::from_mut(&mut accounting).cast(), std::mem::size_of_val(&accounting) as u32,
            None).unwrap();
    }
    (accounting.ActiveProcesses, accounting.TotalProcesses)
}

#[cfg(windows)]
fn assert_windows_fixture_process_running(process: BorrowedHandle<'_>, name: &str) {
    use windows::Win32::Foundation::{HANDLE, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::WaitForSingleObject;

    let state = unsafe { WaitForSingleObject(HANDLE(process.as_raw_handle()), 0) };
    assert_eq!(state, WAIT_TIMEOUT, "{name} must still be running");
}

#[cfg(windows)]
fn wait_for_windows_fixture_exit(
    process: BorrowedHandle<'_>,
    deadline: Instant,
    name: &str,
    expected_code: u32,
) {
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};

    let handle = HANDLE(process.as_raw_handle());
    let remaining_ms = deadline.saturating_duration_since(Instant::now()).as_millis() as u32;
    let state = unsafe { WaitForSingleObject(handle, remaining_ms) };
    assert_eq!(state, WAIT_OBJECT_0, "{name} did not exit");
    let mut code = 0;
    unsafe { GetExitCodeProcess(handle, &mut code) }.unwrap();
    assert_eq!(code, expected_code, "unexpected {name} exit code");
}

#[cfg(windows)]
fn wait_for_windows_wrapper_exit(base: &Path, wrapper: BorrowedHandle<'_>, deadline: Instant) {
    // The marker is written just before exit; the process handle proves exit 0.
    wait_for_windows_fixture_file(base, "wrapper-exiting", deadline);
    wait_for_windows_fixture_exit(wrapper, deadline, "wrapper", 0);
}

#[cfg(windows)]
fn prepare_windows_wrapper_fixture(base: &Path, pty: &mut PrivatePty, mode: &str, deadline: Instant) {
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    wait_for_windows_fixture_file(base, "child.pid", deadline);
    let pid = fs::read_to_string(base.join("child.pid")).unwrap().parse().unwrap();
    let cli = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) }
        .expect("open the fixture CLI process");
    let cli = unsafe { OwnedHandle::from_raw_handle(cli.0) };
    // The PTY owns the original wrapper handle until capture and close complete.
    let wrapper = unsafe { BorrowedHandle::borrow_raw(pty.child.as_raw_handle().unwrap()) };
    let gated_wrapper = if mode == "wrapper_between_polls" {
        Some(wrapper.try_clone_to_owned().unwrap())
    } else {
        wait_for_windows_wrapper_exit(base, wrapper, deadline);
        None
    };
    assert_windows_fixture_process_running(cli.as_handle(), "CLI");
    let job = pty.job.as_ref().unwrap();
    assert!(!job.is_empty().unwrap(), "CLI must remain in the job");
    if mode != "wrapper_exits" {
        let job = job.handle().try_clone_to_owned().unwrap();
        let writer = std::mem::replace(&mut pty.writer, Box::new(std::io::sink()));
        pty.writer = Box::new(FailedWindowsConfirmation {
            base: base.to_path_buf(),
            deadline,
            wrapper: gated_wrapper,
            cli,
            job: Some(job),
            _writer: writer,
        });
    }
}

#[cfg(windows)]
struct FailedWindowsConfirmation {
    base: PathBuf,
    deadline: Instant,
    wrapper: Option<OwnedHandle>,
    cli: OwnedHandle,
    job: Option<OwnedHandle>,
    _writer: Box<dyn Write + Send>,
}

#[cfg(windows)]
impl Write for FailedWindowsConfirmation {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        assert_eq!(bytes, b"\r");
        assert_windows_fixture_process_running(self.cli.as_handle(), "CLI");
        let job = self.job.take().expect("only one confirmation write is expected");
        let (active, total) = query_windows_job_counts(job.as_handle());
        assert!(active > 0 && total >= active && total >= 2, "the job must account for the wrapper and CLI");
        if let Some(wrapper) = &self.wrapper {
            assert!(active >= 2, "both wrapper and CLI must be alive entering the write");
            assert_windows_fixture_process_running(wrapper.as_handle(), "wrapper");
        }

        fs::write(self.base.join("confirm-failed"), b"").unwrap();
        if let Some(wrapper) = &self.wrapper {
            wait_for_windows_wrapper_exit(&self.base, wrapper.as_handle(), self.deadline);
            assert_windows_fixture_process_running(self.cli.as_handle(), "CLI");
        }
        fs::write(self.base.join("let-cli-exit"), b"").unwrap();
        wait_for_windows_fixture_exit(self.cli.as_handle(), self.deadline, "CLI", 7);
        wait_for_windows_fixture(self.deadline, "the job to become empty", || {
            query_windows_job_counts(job.as_handle()).0 == 0
        });
        Err(std::io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

#[cfg(windows)]
#[test]
fn setup_token_windows_cmd_confirms_the_success_screen() {
    let (base, terminal, store, audit, owner_checks) = run_windows_cmd_fixture("confirm", |_, _| {}, drop);
    assert_eq!(owner_checks, 1);
    assert_eq!(terminal.state, SetupTokenState::Saved, "{:?}", terminal.reason);
    assert!(base.path().join("confirmed").is_file(), "the .exe must receive Enter and exit normally");
    assert!(store.0.borrow().get(ID).is_some_and(|value| value == &fake_token()));
    assert!(audit.child_stopped && audit.wiped_buffer.iter().all(|byte| *byte == 0));
    assert_eq!(fs::read_dir(staging::staging_root(base.path())).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
fn setup_token_windows_confirms_then_stops_the_job_before_closing_conpty() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (base, terminal, store, audit, owner_checks) = run_windows_cmd_fixture("linger", move |_, pty| {
        pty.test_hooks.before_job_release = Some(Box::new(move |job| {
            sender.send(query_windows_job_counts(job)).unwrap();
        }));
    }, drop);
    let (active, total) = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(active, 0, "the OS must report an empty job before the product releases it");
    assert!(total >= 2, "the job must have contained the wrapper and CLI");
    assert_eq!(owner_checks, 1);
    assert!(base.path().join("confirmed").is_file());
    assert_eq!(store.read(ID).unwrap().as_deref(), Some(fake_token().as_str()));
    assert_eq!(terminal.state, SetupTokenState::Saved, "{:?}", terminal.reason);
    assert!(audit.child_stopped);
}

#[cfg(windows)]
#[test]
fn setup_token_windows_job_stops_the_cli_after_its_wrapper_already_exited() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let (base, terminal, store, audit, _) =
        run_windows_cmd_fixture("wrapper_exits", |_, _| {}, drop);
    let pid: u32 = fs::read_to_string(base.path().join("child.pid")).unwrap().parse().unwrap();
    let listing = Command::new("tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .creation_flags(crate::util::process::CREATE_NO_WINDOW)
        .output().unwrap();
    assert!(listing.status.success());
    assert!(!String::from_utf8_lossy(&listing.stdout).contains(&format!("\",\"{pid}\",")));
    assert!(base.path().join("confirmed").is_file());
    assert_eq!(store.read(ID).unwrap().as_deref(), Some(fake_token().as_str()));
    assert!(audit.child_stopped);
    assert_eq!(terminal.state, SetupTokenState::Saved, "{:?}", terminal.reason);
}

#[cfg(windows)]
#[test]
fn setup_token_windows_job_stop_failure_keeps_the_previous_value() {
    let (base, terminal, store, audit, owner_checks) = run_windows_cmd_fixture("linger",
        |_, pty| pty.job.as_mut().unwrap().restrict_to_query().unwrap(), drop);
    assert_eq!(owner_checks, 0);
    assert!(base.path().join("confirmed").is_file());
    assert!(!audit.child_stopped);
    assert_eq!(terminal.state, SetupTokenState::Failed);
    assert_eq!(terminal.reason.as_deref(), Some("capture_failed"));
    assert_eq!(store.read(ID).unwrap().as_deref(), Some(previous_windows_fixture_value().as_str()));
}

#[cfg(windows)]
#[test]
fn setup_token_windows_failed_confirmation_cannot_use_the_wrappers_zero_exit() {
    let (base, terminal, store, audit, owner_checks) =
        run_windows_cmd_fixture("wrapper_confirmation_fails", |_, _| {}, drop);
    assert!(base.path().join("confirm-failed").is_file());
    assert_eq!(owner_checks, 0);
    assert!(audit.child_stopped);
    assert_eq!(terminal.state, SetupTokenState::Failed);
    assert_eq!(terminal.reason.as_deref(), Some("capture_failed"));
    assert!(store.read(ID).unwrap().as_deref() == Some(previous_windows_fixture_value().as_str()));
}

#[cfg(windows)]
#[test]
fn setup_token_windows_failed_confirmation_rejects_exits_between_job_polls() {
    let (base, terminal, store, audit, owner_checks) =
        run_windows_cmd_fixture("wrapper_between_polls", |_, _| {}, drop);
    assert!(base.path().join("let-cli-exit").is_file());
    assert!(audit.child_stopped);
    assert_eq!(terminal.state, SetupTokenState::Failed);
    assert_eq!(terminal.reason.as_deref(), Some("capture_failed"));
    assert_eq!(owner_checks, 0);
    assert!(store.read(ID).unwrap().as_deref() == Some(previous_windows_fixture_value().as_str()));
}

#[cfg(windows)]
#[tokio::test]
async fn setup_token_windows_unconfirmed_stop_overrides_cancellation_and_releases_job() {
    let logs = tempfile::tempdir().unwrap();
    let (release, hold_close) = mpsc::sync_channel(1);
    let (base, terminal, store, audit, owner_checks) = crate::diag::with_test_dir(logs.path().to_path_buf(), async move {
        run_windows_cmd_fixture("cancel_pending",
            |_, pty| pty.job.as_mut().unwrap().restrict_to_query().unwrap(), move |pty| {
            // A slow Close must not be responsible for releasing the Job.
            let _ = hold_close.recv_timeout(WINDOWS_FIXTURE_SYNC_TIMEOUT);
            drop(pty);
        })
    }).await;
    assert_eq!(terminal.state, SetupTokenState::Failed);
    assert_eq!(terminal.reason.as_deref(), Some("capture_failed"));
    assert!(!audit.child_stopped);
    assert!(store.read(ID).unwrap().as_deref() == Some(previous_windows_fixture_value().as_str()));
    assert_eq!(owner_checks, 0);
    let logs_text = fs::read_to_string(logs.path().join("diag.log")).unwrap();
    setup_l0d_expect_line(&logs_text, "capture_failed", "stop_unconfirmed", &[("previous_reason", "cancelled")]);
    let pid = fs::read_to_string(base.path().join("child.pid")).unwrap();
    use std::os::windows::process::CommandExt;
    let listing = std::process::Command::new("tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .creation_flags(crate::util::process::CREATE_NO_WINDOW)
        .output().unwrap();
    assert!(listing.status.success());
    assert!(!String::from_utf8_lossy(&listing.stdout).contains(&format!("\",\"{pid}\",")));
    release.send(()).unwrap();
}

#[cfg(windows)]
#[test]
fn setup_token_windows_overflow_drains_through_conpty_close() {
    let (closed, done) = mpsc::sync_channel(1);
    let (_, terminal, store, audit, owner_checks) = run_windows_cmd_fixture("overflow_during_close",
        |_, _| {}, move |pty| { drop(pty); let _ = closed.send(()); });
    assert_eq!(terminal.state, SetupTokenState::Failed);
    assert_eq!(terminal.reason.as_deref(), Some("output_limit"));
    assert_eq!(owner_checks, 0);
    assert!(store.read(ID).unwrap().as_deref() == Some(previous_windows_fixture_value().as_str()));
    assert!(audit.child_stopped && audit.wiped_buffer.len() <= OUTPUT_LIMIT);
    assert!(audit.wiped_buffer.iter().all(|byte| *byte == 0));
    done.recv_timeout(Duration::from_secs(3)).expect("ConPTY close worker must finish");
}

#[cfg(windows)]
#[test]
fn setup_token_windows_deadline_releases_a_blocked_output_reader() {
    let (mut output, pipe_writer) = std::io::pipe().unwrap();
    let (reading, reader_started) = mpsc::sync_channel(1);
    let (released, reader_released) = mpsc::sync_channel(1);
    let (closed, close_finished) = mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        reading.send(()).unwrap();
        let result = output.read(&mut [0]);
        drop(output);
        let _ = released.send(result);
    });
    reader_started.recv_timeout(WINDOWS_FIXTURE_SYNC_TIMEOUT).expect("reader did not start");
    let closer = std::thread::spawn(move || {
        // Keep the pipe open until its reader is released, as a blocked Close
        // would. The timeout only bounds the failing test.
        let result = reader_released.recv_timeout(WINDOWS_FIXTURE_SYNC_TIMEOUT);
        drop(pipe_writer);
        let _ = closed.send(result);
    });
    let stop_reading = Arc::new(AtomicBool::new(false));
    let now = Instant::now();
    let completion = windows_job::finish_output(reader, closer, stop_reading.clone(), now,
        now + Duration::from_secs(2), windows_job::OutputTestHooks::default());
    assert!(completion.complete());
    assert!(stop_reading.load(Ordering::SeqCst));
    let result = close_finished.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
    assert!(result.is_err(), "cancelling the read must unblock Close");
}

#[cfg(windows)]
struct ObserveEof {
    reader: TestReader,
    on_eof: Option<Box<dyn FnOnce() + Send>>,
}

#[cfg(windows)]
impl Read for ObserveEof {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let result = self.reader.read(buffer);
        if matches!(&result, Ok(0)) || result.as_ref().is_err_and(|error|
            error.raw_os_error() == Some(windows::Win32::Foundation::ERROR_BROKEN_PIPE.0 as i32))
        {
            if let Some(on_eof) = self.on_eof.take() { on_eof(); }
        }
        result
    }
}

#[cfg(windows)]
#[test]
fn setup_token_windows_cancellation_errors_leave_the_previous_value_and_reap() {
    use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_NOT_FOUND};

    for error in [ERROR_ACCESS_DENIED, ERROR_NOT_FOUND] {
        let (blocked, reader_blocked) = mpsc::sync_channel(1);
        let (release, hold_reader) = mpsc::sync_channel(1);
        let (closed, close_finished) = mpsc::sync_channel(1);
        let (reaped, workers_joined) = mpsc::sync_channel(1);
        let calls = Arc::new(AtomicUsize::new(0));
        let cancel_calls = calls.clone();
        let (base, terminal, store, audit, owner_checks) = run_windows_cmd_fixture("confirm",
            move |_, pty| {
                pty.test_hooks.wrap_reader = Some(Box::new(move |reader| Box::new(ObserveEof {
                    reader, on_eof: Some(Box::new(move || {
                        blocked.send(()).unwrap();
                        hold_reader.recv_timeout(WINDOWS_FIXTURE_SYNC_TIMEOUT).unwrap();
                    })),
                })));
                pty.test_hooks.output.cancel = Some(Box::new(move |_| {
                    cancel_calls.fetch_add(1, Ordering::SeqCst);
                    Err(windows::core::HRESULT::from_win32(error.0).into())
                }));
                pty.test_hooks.output.reaped = Some(reaped);
            }, move |pty| { drop(pty); closed.send(()).unwrap(); });
        assert!(base.path().join("confirmed").is_file());
        reader_blocked.recv_timeout(WINDOWS_FIXTURE_SYNC_TIMEOUT).unwrap();
        close_finished.recv_timeout(WINDOWS_FIXTURE_SYNC_TIMEOUT).unwrap();
        assert_eq!(workers_joined.try_recv(), Err(mpsc::TryRecvError::Empty));
        let calls_at_return = calls.load(Ordering::SeqCst);
        if error == ERROR_NOT_FOUND { assert!(calls_at_return >= 2); }
        else { assert_eq!(calls_at_return, 1); }
        release.send(()).unwrap();
        workers_joined.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), calls_at_return, "no retries after the deadline");
        assert!(audit.child_stopped);
        assert_eq!(terminal.state, SetupTokenState::Failed);
        assert_eq!(terminal.reason.as_deref(), Some("capture_failed"));
        assert_eq!(owner_checks, 0);
        assert!(store.read(ID).unwrap().as_deref() == Some(previous_windows_fixture_value().as_str()));
    }
}

#[cfg(windows)]
#[test]
fn setup_token_windows_eof_with_a_pending_close_cannot_replace_the_saved_value() {
    let (eof, reader_at_eof) = mpsc::sync_channel(1);
    let (waiting, close_waiting) = mpsc::sync_channel(1);
    let (release, hold_close) = mpsc::sync_channel(1);
    let (reaped, workers_joined) = mpsc::sync_channel(1);
    let (base, terminal, store, audit, owner_checks) = run_windows_cmd_fixture("confirm",
        move |_, pty| {
            pty.test_hooks.wrap_reader = Some(Box::new(move |reader| Box::new(ObserveEof {
                reader, on_eof: Some(Box::new(move || eof.send(()).unwrap())),
            })));
            pty.test_hooks.output.reaped = Some(reaped);
        }, move |pty| {
            drop(pty);
            reader_at_eof.recv_timeout(WINDOWS_FIXTURE_SYNC_TIMEOUT).unwrap();
            waiting.send(()).unwrap();
            hold_close.recv_timeout(WINDOWS_FIXTURE_SYNC_TIMEOUT).unwrap();
        });
    assert!(base.path().join("confirmed").is_file());
    close_waiting.recv_timeout(WINDOWS_FIXTURE_SYNC_TIMEOUT).unwrap();
    assert_eq!(workers_joined.try_recv(), Err(mpsc::TryRecvError::Empty));
    release.send(()).unwrap();
    workers_joined.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(audit.child_stopped);
    assert_eq!(terminal.state, SetupTokenState::Failed);
    assert_eq!(terminal.reason.as_deref(), Some("capture_failed"));
    assert_eq!(owner_checks, 0);
    assert!(store.read(ID).unwrap().as_deref() == Some(previous_windows_fixture_value().as_str()));
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

#[cfg(unix)]
#[test]
fn setup_token_does_not_confirm_stop_while_the_group_exists() {
    assert!(!confirm_process_group_exit(|| false, Duration::ZERO));
}

#[cfg(unix)]
#[test]
fn setup_token_rechecks_the_group_until_it_disappears() {
    let probes = std::cell::Cell::new(0);
    assert!(confirm_process_group_exit(|| {
        probes.set(probes.get() + 1);
        probes.get() >= 2
    }, Duration::from_secs(1)));
    assert_eq!(probes.get(), 2);
}

#[cfg(unix)]
fn pty_for_stop_test(child: impl Child + Send + Sync + 'static) -> PrivatePty {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .unwrap();
    PrivatePty { child: Box::new(child), writer: Box::new(std::io::sink()), _master: pair.master, stopped: None }
}

#[cfg(unix)]
#[test]
fn setup_token_stop_child_checks_the_group_after_an_accepted_signal() {
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::Command;

    let leader = Command::new("/bin/sleep").arg("5").process_group(0).spawn().unwrap();
    let group = i32::try_from(leader.id()).unwrap();
    let mut pty = pty_for_stop_test(leader);
    let mut member = Command::new("/bin/sleep").arg("5").process_group(group).spawn().unwrap();

    // Keep a direct child of the test unreaped so the group can still be
    // observed after stop_child reaps its own child. Reap it before asserting.
    let stopped = pty.stop();
    let member_status = member.wait().unwrap();
    assert_eq!(member_status.signal(), Some(libc::SIGKILL));
    assert!(!stopped, "a SIGKILL accepted for the group is not proof that it disappeared");
}

#[cfg(unix)]
#[test]
fn setup_token_stop_child_accepts_a_reaped_child_without_a_process_id() {
    #[derive(Debug)]
    struct ExitedChild;
    impl portable_pty::ChildKiller for ExitedChild {
        fn kill(&mut self) -> std::io::Result<()> { panic!("the child already exited") }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> { Box::new(Self) }
    }
    impl Child for ExitedChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> { self.wait().map(Some) }
        fn wait(&mut self) -> std::io::Result<ExitStatus> { Ok(ExitStatus::with_exit_code(0)) }
        fn process_id(&self) -> Option<u32> { None }
    }

    assert!(pty_for_stop_test(ExitedChild).stop());
}

#[cfg(target_os = "macos")]
#[test]
fn setup_token_macos_checks_the_group_after_reaping_an_exited_child() {
    let (base, cmd, live) = fixture("exit");
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let audit = run_attempt_with_pty(&registry, initial, control, base.path(), &live, cmd,
        RunOptions::default(), &MemoryStore::default(), |_| panic!("no token"),
        |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {},
        |pty| {
            let pid = pty.child.process_id().unwrap().to_string();
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let output = std::process::Command::new("/bin/ps")
                    .args(["-o", "stat=", "-p", &pid]).output().unwrap();
                if String::from_utf8_lossy(&output.stdout).trim_start().starts_with('Z') {
                    break;
                }
                assert!(Instant::now() < deadline, "fixture child did not exit");
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(pty.stop(), "an already exited child and an empty group count as stopped");
        }, drop);
    assert!(audit.child_stopped);
}

#[cfg(test)]
const SETUP_0915_CI_START: &str = "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H";

fn setup_0915_final(raw: impl AsRef<[u8]>) -> Option<Vec<u8>> {
    capture_complete(&SecretBytes(raw.as_ref().to_vec()))
        .ok()
        .map(|token| token.as_slice().to_vec())
}

#[test]
fn setup_token_0915_heading_must_still_be_visible_in_the_active_screen() {
    let token = fake_token();
    for (label, raw) in [
        ("cleared", format!("Your OAuth token:\r\n\x1b[2J{token}\r\n")),
        ("scrolled", format!("Your OAuth token:\r\n\x1b[S{token}\r\n")),
        ("explanation", format!("This documents the Your OAuth token: prompt.\r\n{token}\r\n")),
        ("separated", format!("Your OAuth token:\r\n\r\n{token}\r\n")),
    ] {
        assert!(setup_0915_final(raw).is_none(), "{label}");
    }
}

#[test]
fn setup_token_0915_initial_carriage_return_preserves_the_heading() {
    let token = fake_token();
    for command in ["", "\x1b[H", "\x1b[1;1f"] {
        let raw = format!("\r{command}Your OAuth token:\r\n{token}\r\n");
        assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()), "{command:?}");
    }
}

#[test]
fn setup_token_0915_heading_in_last_column_is_rejected_but_an_indented_heading_fits() {
    let token = fake_token();
    let heading = "Your OAuth token:";
    let space = " ".repeat(512 - heading.len());
    let last = format!("{space}{heading}\r\n{token}\r\n");
    let fits = format!("{}{heading}\r\n{token}\r\n", &space[1..]);
    assert_eq!(setup_0915_final(fits).as_deref(), Some(token.as_bytes()));
    assert!(setup_0915_final(last).is_none());
}

#[test]
fn setup_token_0915_erase_does_not_join_old_and_new_cells() {
    let token = fake_token();
    let (first, last) = token.split_at(token.len() / 2);
    for start in ["", SETUP_0915_CI_START] {
        for erase in ["\x1b[2K", "\x1b[2J"] {
            let raw = format!("{start}Your OAuth token:\r\n{first}{erase}{last}\r\n");
            assert!(setup_0915_final(raw).is_none(), "{start:?} {erase:?}");
        }
        let repaint = format!("{start}Your OAuth token:\r\n{first}\x1b[2K\x1b[G{token}\r\n");
        assert_eq!(setup_0915_final(repaint).as_deref(), Some(token.as_bytes()));
    }
}

#[test]
fn setup_token_0915_partial_redraw_cannot_drop_the_untouched_tail() {
    let token = fake_token();
    let original = ".".repeat(token.len());
    for start in ["", SETUP_0915_CI_START] {
        let raw = format!("{start}Your OAuth token:\r\n{original}!\r\n\x1b[2;1H{token}\r\n");
        assert!(setup_0915_final(&raw).is_none(), "{start:?}");
        let repaint = format!("{raw}\x1b[2;{}H\x1b[K", token.len() + 1);
        assert_eq!(setup_0915_final(repaint).as_deref(), Some(token.as_bytes()));
    }
}

#[test]
fn setup_token_0915_visible_continuation_cannot_leave_a_candidate() {
    let token = fake_token();
    for start in ["", SETUP_0915_CI_START] {
        let raw = format!("{start}Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n\
            \x1b[3;1H\x1b[2KCD\r\n");
        assert!(setup_0915_final(&raw).is_none(), "{start:?}");
        let repaint = format!("{raw}\x1b[3;1H\x1b[2K\x1b[GPress Enter to continue.\r\n");
        assert_eq!(setup_0915_final(repaint).as_deref(), Some(token.as_bytes()));
    }
}

#[test]
fn setup_token_0915_later_partial_update_invalidates_the_candidate() {
    let token = fake_token();
    for start in ["", SETUP_0915_CI_START] {
        let raw = format!("{start}Your OAuth token:\r\n{token}\r\n\
            Press Enter to continue.\x1b[2;2HZ\r\n");
        assert!(setup_0915_final(&raw).is_none(), "{start:?}");
        let repaint = format!("{raw}\x1b[2;2Hk");
        assert_eq!(setup_0915_final(repaint).as_deref(), Some(token.as_bytes()));
    }
}

#[test]
fn setup_token_0915_empty_rows_after_erase_or_scroll_are_usable() {
    let token = fake_token();
    for clear in ["\x1b[2J", "\x1b[3J", "\x1b[1S"] {
        let raw = format!("notice\r\n{clear}\x1b[HYour OAuth token:\r\n{token}\r\n");
        assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()), "{clear:?}");
    }
    let raw = format!("\x1b[40;1Hnotice\r\n\x1b[40;1fYour OAuth token:\r\n{token}\r\n");
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));
}

#[test]
fn setup_token_0915_zero_column_defaults_to_the_first_column() {
    let token = fake_token();
    for command in ['H', 'f'] {
        let raw = format!("\x1b[1;0{command}Your OAuth token:\r\n{token}\r\n");
        assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()), "{command}");
    }
}

#[test]
fn setup_token_0915_ink_repaints_only_the_confirmation_notice() {
    let token = fake_token();
    let raw = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n\
        \x1b[A\x1b[2KPress Enter to continue.\r\n");
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));
}

#[test]
fn setup_token_0915_ink_repaint_uses_the_value_visible_after_clear() {
    let token = fake_token();
    let next = format!("{}b", &token[..token.len() - 1]);
    for erase in ["\x1b[2J", "\x1b[3J"] {
        let raw = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n\
            {erase}\x1b[HYour OAuth token:\r\n{next}\r\n\x1b[GPress Enter to continue.\r\n");
        assert_eq!(setup_0915_final(raw).as_deref(), Some(next.as_bytes()), "{erase:?}");
    }
}

#[test]
fn setup_token_0915_value_in_last_column_cannot_supply_a_candidate() {
    let token = fake_token();
    let spacing = " ".repeat(512 - token.len());
    let raw = format!("Your OAuth token:\r\n{spacing}{token}\r\n");
    assert!(setup_0915_final(raw).is_none());
    let raw = format!("Your OAuth token:\r\n{}{token}\r\n", &spacing[1..]);
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));
    let long = format!("{token}{}", "a".repeat(410));
    for mode in ["\x1b[?7h", "\x1b[?7l"] {
        let raw = format!("{mode}Your OAuth token:\r\n{long}\r\n");
        assert!(setup_0915_final(raw).is_none(), "{mode:?}");
    }
}

#[test]
fn setup_token_0915_value_on_the_bottom_row_cannot_supply_a_candidate() {
    let token = fake_token();
    let raw = format!("\x1b[39;1HYour OAuth token:\r\n{token}\x1b[A");
    assert!(setup_0915_final(&raw).is_none());
    let raw = format!("{raw}\x1b[40;1H\r\n");
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));
}

#[test]
fn setup_token_0915_other_visible_token_shapes_must_agree() {
    let token = fake_token();
    let raw = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n");
    // VPA preserves the column: the final fourth row reads "sk".
    let conflict = format!("{raw}s\x1b[5d\x1b[4dk\r\n");
    assert!(setup_0915_final(conflict).is_none());
    assert!(setup_0915_final(format!("{raw}{token}b\r\n")).is_none());
    assert_eq!(setup_0915_final(format!("{raw}{token}\r\n")).as_deref(), Some(token.as_bytes()));
}

#[test]
fn setup_token_0915_sgr_conceal_blanks_only_the_cells_written_while_active() {
    let token = fake_token();
    let raw = format!("Your OAuth token:\r\n\x1b[8m{token}\x1b[28m\r\n");
    assert!(setup_0915_final(&raw).is_none());
    let repaint = format!("{raw}\x1b[A{token}\r\n");
    assert_eq!(setup_0915_final(repaint).as_deref(), Some(token.as_bytes()));
    let hidden_heading = format!("\x1b[8mYour OAuth token:\x1b[0m\r\n{token}\r\n");
    assert!(setup_0915_final(hidden_heading).is_none());
}

#[test]
fn setup_token_0915_both_conpty_captures_and_plain_screen_are_usable() {
    let token = fake_token();
    let ci = format!("{SETUP_0915_CI_START}Your OAuth token:\r\n{token}\r\n\
        Press Enter to continue.\x1b]0;C:\\Windows\\System32\\cmd.exe\x07\x1b[?25h\r\nconfirmed\r\n");
    let wez = format!("\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h\x1b[?7l\x1b[?7h\
        Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\nconfirmed\r\n");
    assert_eq!((ci.len(), wez.len()), (236, 199));
    let blank = ci.replacen("Your OAuth token:", "\r\nYour OAuth token:", 1);
    let no_home = ci.replacen("\x1b[H", "", 1);
    assert_eq!((blank.len(), no_home.len()), (238, 233));
    let plain = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n");
    for (label, raw) in [("CI", ci), ("WezTerm", wez), ("blank row", blank), ("no home", no_home), ("plain", plain)] {
        assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()), "{label}");
    }
}

#[test]
fn setup_token_0915_ambiguous_width_needs_an_anchored_column_outside_the_notice() {
    let token = fake_token();
    let raw = format!("Notice\u{2026}\x1b[2dYour OAuth token:\x1b[3d{token}\r\n");
    assert!(setup_0915_final(raw).is_none());
    let protected = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue\u{2026}\r\n");
    assert_eq!(setup_0915_final(protected).as_deref(), Some(token.as_bytes()));
    let fully_erased = format!("Notice\u{2026}\x1b[2K\x1b[HYour OAuth token:\r\n{token}\r\n");
    assert_eq!(setup_0915_final(fully_erased).as_deref(), Some(token.as_bytes()));
}

#[test]
fn setup_token_0915_ambiguous_width_cannot_hide_a_partial_repaint() {
    let token = fake_token();
    let raw = format!("Your OAuth token:\r\n{token}\r\nPress Enter\u{2026}");
    for edit in ["\r!", "\x1b[1K", "\x1b[X", "\x1b[P", "\x1b[@"] {
        assert!(setup_0915_final(format!("{raw}{edit}")).is_none(), "{edit:?}");
    }
    let after_clear = format!("{raw}\r!\x1b[2K");
    assert_eq!(setup_0915_final(after_clear).as_deref(), Some(token.as_bytes()));
}

#[cfg(unix)]
fn setup_0915_python(base: &Path, body: &str) -> CommandBuilder {
    use std::os::unix::fs::PermissionsExt;
    let script = base.join("fixture-0915");
    fs::write(&script, format!("#!/usr/bin/env python3\nimport os, sys, time, tty\n\
        tty.setraw(0)\n{body}\n")).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    CommandBuilder::new(script)
}

#[cfg(unix)]
#[test]
fn setup_token_0915_outside_controls_keep_the_stored_value() {
    let mut differences = Vec::new();
    for (label, tail) in [
        ("insert on", b"\x1b[4h".as_slice()),
        ("insert off", b"\x1b[4l"),
        ("origin on", b"\x1b[?6h"),
        ("origin off", b"\x1b[?6l"),
        ("alternate 1049 on", b"\x1b[?1049h"),
        ("alternate 1049 off", b"\x1b[?1049l"),
        ("alternate 47 on", b"\x1b[?47h"),
        ("alternate 47 off", b"\x1b[?47l"),
        ("alternate 1047 on", b"\x1b[?1047h"),
        ("alternate 1047 off", b"\x1b[?1047l"),
        ("private cursor save", b"\x1b[?1048h"),
        ("private cursor restore", b"\x1b[?1048l"),
        ("c1", b"\x9b?25h"),
        ("osc133", b"\x1b]133;A\x07"),
        ("esc cursor save", b"\x1b7"),
        ("esc cursor restore", b"\x1b8"),
        ("csi cursor save", b"\x1b[s"),
        ("csi cursor restore", b"\x1b[u"),
        ("scroll region", b"\x1b[2;6r"),
        ("csi intermediate", b"\x1b[1 q"),
        ("csi c0", b"\x1b[2\x072J"),
        ("unknown escape", b"\x1b#8"),
        ("dcs", b"\x1bPabc\x1b\\"),
        ("interrupted osc", b"\x1b]0;title\x1b[2J\x07"),
        ("vertical tab", b"\x0b"),
        ("form feed", b"\x0c"),
    ] {
        let (base, _, live) = fixture("exit");
        let new = fixture_token(base.path());
        let mut raw = format!("{SETUP_0915_CI_START}Your OAuth token:\r\n{new}\r\nPress Enter to continue.\r\n").into_bytes();
        raw.extend_from_slice(tail);
        raw.extend_from_slice(format!("\x1b[2J\x1b[HYour OAuth token:\r\n{new}\r\n").as_bytes());
        let cmd = setup_0915_python(base.path(), &format!("os.write(1, bytes({raw:?}))"));
        let store = MemoryStore::default();
        let previous = fake_token();
        store.write(ID, &previous).unwrap();
        let registry = SetupTokenRegistry::default();
        let (initial, control) = registry.begin(ID).unwrap();
        let calls = std::cell::Cell::new(0);
        let audit = run_attempt(&registry, initial, control, base.path(), &live, cmd,
            RunOptions::default(), &store, |_| { calls.set(calls.get() + 1); owner(false) },
            |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
        let current = registry.current().unwrap().unwrap();
        if calls.get() != 0 || current.reason.as_deref() != Some("capture_failed")
            || store.read(ID).unwrap().as_deref() != Some(previous.as_str())
            || !audit.child_stopped
        {
            differences.push((label, current.state, current.reason));
        }
    }
    assert!(differences.is_empty(), "{differences:?}");
}

#[cfg(unix)]
#[test]
fn setup_token_0915_weak_owner_checks_keep_the_saved_value_before_both_writes() {
    use crate::cli_accounts::{snapshot, token_owner::OrganizationCheck};
    use std::cell::Cell;
    #[derive(Default)]
    struct CountedStore {
        store: MemoryStore,
        writes: Cell<usize>,
    }
    impl LaunchTokenStore for CountedStore {
        fn read(&self, id: &str) -> Result<Option<String>, String> { self.store.read(id) }
        fn write(&self, id: &str, value: &str) -> Result<(), String> {
            self.writes.set(self.writes.get() + 1);
            self.store.write(id, value)
        }
        fn delete(&self, id: &str) -> Result<(), String> { self.store.delete(id) }
    }

    for label in ["403", "unavailable", "org matched", "org shared"] {
        let (base, _, live) = fixture("exit");
        let next = fixture_token(base.path());
        if label.starts_with("org") {
            let put_org = |id| {
                let account = serde_json::json!({"organizationUuid": "fixture-org"});
                let metadata = serde_json::json!({"oauth_account_text": account.to_string()});
                let dir = snapshot::snapshot_dir(base.path());
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join(format!("{id}.json")), metadata.to_string()).unwrap();
            };
            put_org(ID);
            if label == "org shared" {
                let mut registry = registry::load(base.path()).unwrap();
                let mut profile = registry.profiles[0].clone();
                profile.id = "claude-shared".into();
                profile.identity_key = "owner-2".into();
                registry.profiles.push(profile);
                registry::save(base.path(), &registry).unwrap();
                put_org("claude-shared");
            }
        }
        let store = CountedStore::default();
        let previous = fake_token();
        launch_tokens::save_with_outcome(base.path(), &store, ID, &previous, |_| owner(false)).unwrap();
        store.writes.set(0);
        let status_path = base.path().join("cli_account_launch_tokens.json");
        let before = fs::read(&status_path).unwrap();
        let registry = SetupTokenRegistry::default();
        let (initial, control) = registry.begin(ID).unwrap();
        let raw = format!("Your OAuth token:\r\n{next}\r\n");
        let cmd = setup_0915_python(base.path(), &format!("os.write(1, bytes({:?}))", raw.as_bytes()));
        let audit = run_attempt(&registry, initial, control, base.path(), &live, cmd,
            RunOptions::default(), &store,
            |_| match label {
                "403" => OwnerCheck::Rejected { status: 403 }.into(),
                "unavailable" => OwnerCheck::Unavailable.into(),
                _ => LaunchOwnerCheck {
                    profile: OwnerCheck::Unavailable,
                    organization: Some(OrganizationCheck::Organization("fixture-org".into())),
                },
            },
            |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
        assert!(audit.child_stopped);
        assert_eq!(registry.current().unwrap().unwrap().reason.as_deref(), Some("replacement_unverified"), "{label}");
        assert_eq!(store.writes.get(), 0, "{label}");
        assert_eq!(fs::read(&status_path).unwrap(), before, "{label}");
        assert!(store.read(ID).unwrap().as_deref() == Some(previous.as_str()), "{label}");
    }
}

#[cfg(unix)]
#[test]
fn setup_token_0915_temporary_candidate_preserves_the_queued_code() {
    let (base, _, live) = fixture("exit");
    let token = fixture_token(base.path());
    let gate = base.path().join("draw-review-token");
    let drawn = base.path().join("review-token-drawn");
    let erase = base.path().join("erase-review-token");
    let body = format!(r#"
os.write(1, b'Open https://example.test/oauth/authorize?state=fixture\r\n')
while not os.path.exists({gate:?}): time.sleep(0.01)
os.write(1, b'\033[2J\033[HYour OAuth token:\r\n{token}\r\n')
open({drawn:?}, 'w').close()
while not os.path.exists({erase:?}): time.sleep(0.01)
os.write(1, b'\033[2J\033[HEnter the authorization code:\r\n')
code = b''
while not code.endswith(b'\r'): code += os.read(0, 256)
if code != b'fixture-code#fixture-state\r': sys.exit(2)
os.write(1, b'\033[2J\033[HYour OAuth token:\r\n{token}\r\n')
"#, gate=gate.to_str().unwrap(), drawn=drawn.to_str().unwrap(), erase=erase.to_str().unwrap());
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let store = MemoryStore::default();
    let mut reopened = false;
    let audit = run_attempt(&registry, initial, control, base.path(), &live, setup_0915_python(base.path(), &body),
        RunOptions { timeout: Duration::from_secs(8), fallback_after: Duration::ZERO,
            token_exit_grace: Duration::from_secs(1), ..RunOptions::default() },
        &store, |_| owner(false), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials),
        |event| {
            if event.state == SetupTokenState::CodeAvailable && event.url.is_some() {
                if gate.exists() {
                    reopened = true;
                    assert!(registry.submit_code(&event.login_id, "another#code".into()).is_err());
                } else {
                    registry.submit_code(&event.login_id, "fixture-code#fixture-state".into()).unwrap();
                    fs::write(&gate, b"").unwrap();
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while !drawn.exists() && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    assert!(drawn.exists());
                }
            }
            if event.state == SetupTokenState::Confirming {
                fs::write(&erase, b"").unwrap();
            }
        });
    assert!(audit.child_stopped);
    assert!(reopened);
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::Saved);
    assert!(store.read(ID).unwrap().as_deref() == Some(token.as_str()));
}

#[cfg(unix)]
#[test]
fn setup_token_0915_confirmation_grace_restarts_when_the_value_changes() {
    assert_0915_r2_confirmation_delay(false);
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r2_confirmation_grace_restarts_when_the_heading_moves() {
    assert_0915_r2_confirmation_delay(true);
}

#[cfg(unix)]
fn assert_0915_r2_confirmation_delay(move_heading: bool) {
    let (base, _, live) = fixture("exit");
    let previous = fake_token();
    let (next, redraw) = if move_heading {
        (previous.clone(), r"\033[T".to_string())
    } else {
        let token = fixture_token(base.path());
        let redraw = format!(r"\033[2J\033[HYour OAuth token:\r\n{token}\r\n");
        (token, redraw)
    };
    let gate = base.path().join("initial-confirming");
    let timing = base.path().join("confirmation-delay-ms");
    let body = format!(r#"
os.write(1, b'Your OAuth token:\r\n{previous}\r\nPress Enter to continue.\r\n')
while not os.path.exists({gate:?}): time.sleep(0.01)
time.sleep(0.50)
os.write(1, b'{redraw}')
changed_at = time.monotonic()
assert os.read(0, 1) == b'\r'
with open({timing:?}, 'w') as out: out.write(str(round(1000 * (time.monotonic() - changed_at))))
"#, gate=gate.to_str().unwrap(), timing=timing.to_str().unwrap());
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let store = MemoryStore::default();
    let audit = run_attempt(&registry, initial, control, base.path(), &live, setup_0915_python(base.path(), &body),
        RunOptions { timeout: Duration::from_secs(7), token_exit_grace: Duration::from_secs(1), ..RunOptions::default() },
        &store, |_| owner(false), |path| staging::cleanup_staging_with_credentials(path, &NoCredentials),
        |event| { if event.state == SetupTokenState::Confirming { fs::write(&gate, b"").unwrap(); } });
    assert!(audit.child_stopped);
    let delay = fs::read_to_string(timing).ok().and_then(|delay| delay.parse::<u64>().ok());
    assert!(delay.is_some_and(|ms| ms >= 900), "milliseconds from repaint to Enter: {delay:?}");
    assert_eq!(registry.current().unwrap().unwrap().state, SetupTokenState::Saved);
    assert!(store.read(ID).unwrap().as_deref() == Some(next.as_str()));
}

#[cfg(unix)]
#[test]
fn setup_token_0915_confirmation_does_not_save_a_value_erased_at_exit() {
    let (base, _, live) = fixture("exit");
    let token = fixture_token(base.path());
    let body = format!(r#"
os.write(1, b'Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n')
assert os.read(0, 1) == b'\r'
os.write(1, b'\033[2J\033[HSetup complete.\r\n')
"#);
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let store = MemoryStore::default();
    let previous = fake_token();
    store.write(ID, &previous).unwrap();
    let calls = std::cell::Cell::new(0);
    let audit = run_attempt(&registry, initial, control, base.path(), &live, setup_0915_python(base.path(), &body),
        RunOptions { timeout: Duration::from_secs(5), token_exit_grace: Duration::from_millis(100), ..RunOptions::default() },
        &store, |_| { calls.set(calls.get() + 1); owner(false) },
        |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {});
    assert!(audit.child_stopped);
    assert_eq!(registry.current().unwrap().unwrap().reason.as_deref(), Some("capture_failed"));
    assert_eq!(calls.get(), 0);
    assert!(store.read(ID).unwrap().as_deref() == Some(previous.as_str()));
}

#[test]
fn setup_token_0915_row_and_cell_edits_preserve_the_actual_value() {
    let token = fake_token();
    let raw = format!("Your OAuth token:\r\nprefix {token}\r\nPress Enter to continue.\r\n\
        \x1b[2;1H\x1b[7P\x1b[4@\x1b[4X\
        \x1b[H\x1b[2L\x1b[1M\x1b[1T\x1b[2S");
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));

    for edit in ["\x1b[X", "\x1b[K", "\x1b[J"] {
        let edge = format!("Your OAuth token:\r\n\x1b[?7l{}{token}{edit}",
            " ".repeat(512 - token.len()));
        assert_eq!(setup_0915_final(edge).as_deref(), Some(&token.as_bytes()[..token.len() - 1]));
    }
}

#[test]
fn setup_token_0915_handles_delayed_wrap_backspace_tabs_and_erasure() {
    let fill = "a".repeat(512);
    for (edit, first_tail, next) in [
        ("\x08Z", "Za", ""),
        ("\tZ", "aa", "Z"),
        ("\x1b[2KZ", " Z", ""),
        ("\x1b[3JZ", "aa", "Z"),
        ("\x1b[KZ", "aZ", ""),
        ("\x1b[JZ", "aZ", ""),
        ("\x1b[?7lZ", "aZ", ""),
    ] {
        let raw = format!("{fill}{edit}");
        let mut screen = Screen::default();
        screen.finish(raw.as_bytes(), |_, _| false);
        let lines = screen.lines().unwrap();
        assert_eq!(&lines[0].text.as_slice()[510..], first_tail.as_bytes(), "{edit:?}");
        assert_eq!(lines[1].text.as_slice(), next.as_bytes(), "{edit:?}");
    }
    let raw = b"x\tZ";
    let mut screen = Screen::default();
    screen.finish(raw, |_, _| false);
    assert_eq!(screen.lines().unwrap()[0].text.as_slice(), b"x       Z");
}

#[test]
fn setup_token_0915_models_wide_cells_and_ignores_osc_and_synchronized_paint() {
    let token = fake_token();
    let raw = format!("\x1b]0;\u{5237}\u{65b0}\x1b\\Your OAuth token:\r\n\u{6f22}{token}\r\n\
        \x1b[?2026h\x1b[2;2H\x1b[X\x1b[3G{token}\r\nPress Enter to continue.\r\n");
    for split in 0..=raw.len() {
        let mut screen = Screen::default();
        screen.update(&raw.as_bytes()[..split], |_, _| false);
        screen.finish(raw.as_bytes(), |_, _| false);
        let (_, captured) = screen_candidate(&screen).unwrap();
        assert_eq!(captured.as_slice(), token.as_bytes(), "stream split at {split}");
    }
}

#[test]
fn setup_token_0915_color_parameters_are_separate_from_conceal_and_guidance() {
    let token = fake_token();
    let raw = format!("The sk- prefix is part of the format.\r\n\
        \x1b[38;2;8;28;0mYour OAuth token:\x1b[0m\r\n\
        \x1b[48:2::8:28:0m\x1b[8:0m{token}\r\n\x1b[0mPress Enter to continue.\r\n\
        \x1b]0;pending title");
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));
}

#[cfg(unix)]
fn run_0915_r2_stream(
    queue: impl FnOnce(&SyncSender<PtyOutput>) + Send + 'static,
    body: &str,
    options: RunOptions,
    emit: impl FnMut(&SetupTokenRegistry, &SetupTokenEvent),
) -> (String, Vec<SetupTokenEvent>) {
    run_0915_stream_with_pty(queue, body, options, emit, |_, _, _| {})
}

#[cfg(unix)]
fn run_0915_stream_with_pty(
    queue: impl FnOnce(&SyncSender<PtyOutput>) + Send + 'static,
    body: &str,
    options: RunOptions,
    mut emit: impl FnMut(&SetupTokenRegistry, &SetupTokenEvent),
    prepare_pty: impl FnOnce(&std::sync::Arc<SetupTokenRegistry>, &str, &mut PrivatePty),
) -> (String, Vec<SetupTokenEvent>) {
    let (base, _, live) = fixture("exit");
    let ready = base.path().join("input-ready");
    let body = format!("open({:?}, 'w').close()\n{body}", ready.to_str().unwrap());
    let registry = std::sync::Arc::new(SetupTokenRegistry::default());
    let (initial, mut control) = registry.begin(ID).unwrap();
    let login_id = initial.login_id.clone();
    control.queue_output = Some(Box::new(move |sender| {
        // Match a real CLI that draws only after entering raw input mode.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.is_file() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(ready.is_file(), "fake CLI did not enter raw mode");
        queue(sender);
    }));
    let store = MemoryStore::default();
    store.write(ID, &format!("{}b", fake_token())).unwrap();
    let mut events = Vec::new();
    let audit = run_attempt_with_pty(&registry, initial, control, base.path(), &live,
        setup_0915_python(base.path(), &body), options, &store, |_| owner(false),
        |path| staging::cleanup_staging_with_credentials(path, &NoCredentials),
        |event| {
            emit(&registry, &event);
            events.push(event);
        }, |pty| prepare_pty(&registry, &login_id, pty), drop);
    assert!(audit.child_stopped);
    assert!(audit.wiped_buffer.iter().all(|byte| *byte == 0));
    (store.read(ID).unwrap().unwrap(), events)
}

#[cfg(unix)]
fn queue_0915_r2_data(sender: &SyncSender<PtyOutput>, bytes: impl AsRef<[u8]>) -> bool {
    sender.send(PtyOutput::Data(SecretBytes(bytes.as_ref().to_vec()))).is_ok()
}

#[cfg(unix)]
fn queue_0915_r2_bells(screen: String) -> impl FnOnce(&SyncSender<PtyOutput>) + Send {
    |sender| {
        assert!(queue_0915_r2_data(sender, screen));
        for _ in 1..OUTPUT_QUEUE_CAPACITY {
            assert!(queue_0915_r2_data(sender, b"\x07"));
        }
        let sender = sender.clone();
        std::thread::spawn(move || {
            while queue_0915_r2_data(&sender, b"\x07") {
                std::thread::sleep(Duration::from_millis(10));
            }
        });
    }
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r2_confirms_during_continuous_bells() {
    let token = fake_token();
    let screen = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n");
    let options = || RunOptions {
        timeout: Duration::from_secs(2), token_exit_grace: Duration::from_millis(200),
        ..RunOptions::default()
    };
    let (saved, events) = run_0915_r2_stream(queue_0915_r2_bells(screen.clone()),
        "assert os.read(0, 1) == b'\\r'", options(), |_, _| {});
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());

    let conflicting = format!("{screen}{token}c\r\n");
    let (saved, events) = run_0915_r2_stream(queue_0915_r2_bells(conflicting),
        "sys.exit(3) if os.read(0, 1) else sys.exit(4)", options(), |_, _| {});
    assert_eq!(events.last().unwrap().state, SetupTokenState::Timeout);
    assert!(!events.iter().any(|event| event.state == SetupTokenState::Confirming));
    assert_eq!(saved.as_bytes(), format!("{token}b").as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r2_opens_sends_and_terminates_code_during_continuous_bells() {
    let token = fake_token();
    let body = format!(r#"
code = b''
while not code.endswith(b'\r'):
    chunk = os.read(0, 4096)
    if not code: first = time.monotonic()
    code += chunk
assert code == b'fixture-code#fixture-state\r'
assert time.monotonic() - first >= 0.14
os.write(1, b'\033[2J\033[HYour OAuth token:\r\n{token}\r\n')
"#);
    let mut submitted = false;
    let (saved, events) = run_0915_r2_stream(
        queue_0915_r2_bells("Enter the authorization code:\r\n".into()), &body,
        RunOptions { timeout: Duration::from_secs(2), fallback_after: Duration::from_millis(120),
            ..RunOptions::default() },
        |registry, event| {
            if event.state == SetupTokenState::CodeAvailable && !submitted {
                registry.submit_code(&event.login_id, "fixture-code#fixture-state".into()).unwrap();
                submitted = true;
            }
        });
    assert!(submitted, "fallback must open during output");
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r2_waits_through_a_split_osc_without_restarting_grace() {
    let token = fake_token();
    let screen = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n");
    let markers = tempfile::tempdir().unwrap();
    let ended = markers.path().join("osc-ended");
    let marker = ended.clone();
    let (confirm, confirmed) = mpsc::channel();
    let queue = move |sender: &SyncSender<PtyOutput>| {
        assert!(queue_0915_r2_data(sender, screen));
        let sender = sender.clone();
        std::thread::spawn(move || {
            if confirmed.recv_timeout(Duration::from_secs(2)).is_err() { return; }
            if !queue_0915_r2_data(&sender, b"\x1b]0;x") { return; }
            std::thread::sleep(Duration::from_millis(1000));
            if queue_0915_r2_data(&sender, b"\x07") {
                fs::write(marker, b"").unwrap();
            }
        });
    };
    let body = format!(r#"
assert os.read(0, 1) == b'\r'
assert not os.path.exists({ended:?}), 'ordinary OSC delayed Enter'
while not os.path.exists({ended:?}): time.sleep(0.005)
"#, ended = ended.to_str().unwrap());
    let mut confirm = Some(confirm);
    let (saved, events) = run_0915_r2_stream(queue, &body,
        RunOptions { timeout: Duration::from_secs(3), token_exit_grace: Duration::from_millis(500),
            ..RunOptions::default() },
        |_, event| {
            if event.state == SetupTokenState::Confirming {
                if let Some(confirm) = confirm.take() { confirm.send(()).unwrap(); }
            }
        });
    assert_eq!(events.iter().filter(|event| event.state == SetupTokenState::Confirming).count(), 1);
    assert!(events.iter().all(|event| event.reason.as_deref() != Some("code_reopened")));
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r2_does_not_confirm_if_a_split_escape_finishes_outside_the_set() {
    let token = fake_token();
    let screen = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n");
    let queue = move |sender: &SyncSender<PtyOutput>| {
        assert!(queue_0915_r2_data(sender, screen));
        let sender = sender.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(75));
            if !queue_0915_r2_data(&sender, b"\x1b") { return; }
            std::thread::sleep(Duration::from_millis(300));
            queue_0915_r2_data(&sender, b"7");
        });
    };
    let (saved, events) = run_0915_r2_stream(queue,
        "assert not __import__('select').select([0], [], [], 0.65)[0]", RunOptions {
            timeout: Duration::from_secs(3), token_exit_grace: Duration::from_millis(200),
            ..RunOptions::default()
        }, |_, _| {});
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("capture_failed"));
    assert_eq!(events.iter().filter(|event| event.reason.as_deref() == Some("code_reopened")).count(), 1);
    assert_eq!(saved.as_bytes(), format!("{token}b").as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r2_joins_queued_chunks_before_diagnosing_an_error() {
    let token = fake_token();
    let first = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\nPress Enter to retry");
    let (saved, events) = run_0915_r2_stream(move |sender| {
        assert!(queue_0915_r2_data(sender, first));
        assert!(queue_0915_r2_data(sender, b" later.\r\n"));
    }, "pass", RunOptions::default(), |_, _| {});
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r2_only_diagnoses_completed_error_lines_while_running() {
    let token = fake_token();
    let (saved, events) = run_0915_r2_stream(|sender| {
        assert!(queue_0915_r2_data(sender, b"Press Enter to retry"));
        let sender = sender.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            queue_0915_r2_data(&sender, b" later.\r\n");
        });
    }, &format!("time.sleep(0.3)\nos.write(1, b'Your OAuth token:\\r\\n{token}\\r\\n')"),
        RunOptions::default(), |_, _| {});
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());

    for (retry, body) in [(b"Press Enter to retry\r\n".as_slice(), "time.sleep(30)"),
        (b"Press Enter to retry".as_slice(), "pass")] {
        let (saved, events) = run_0915_r2_stream(move |sender| {
            assert!(queue_0915_r2_data(sender, retry));
        }, body, RunOptions { timeout: Duration::from_secs(2), ..RunOptions::default() }, |_, _| {});
        assert_eq!(events.last().unwrap().reason.as_deref(), Some("cli_error"),
            "terminated by LF: {}, states: {:?}", retry.ends_with(b"\n"),
            events.iter().map(|event| &event.state).collect::<Vec<_>>());
        assert_eq!(saved.as_bytes(), format!("{token}b").as_bytes());
    }
}

#[test]
fn setup_token_0915_r2_requires_the_diagnosed_error_to_remain_visible() {
    let token = fake_token();
    let screen = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n");
    for (left, right) in [
        ("Press Enter ", "to retry."),
        ("OAuth ", "error: invalid grant"),
        ("Anthropic reported the token ", "revoked; it was not shown."),
    ] {
        let separated = format!("{screen}{left}\x1b[{}G{right}\r\n", left.len() + 2);
        let visible = format!("{screen}{left}\x1b[{}G{right}\r\n", left.len() + 1);
        let hidden = format!("{screen}\x1b[8m{left}{right}\x1b[28m\r\n");
        assert!(matches!(capture_complete(&SecretBytes(visible.into_bytes())), Err(CaptureFailure::CliError)));
        assert_eq!(setup_0915_final(separated).as_deref(), Some(token.as_bytes()), "{left:?}");
        assert_eq!(setup_0915_final(hidden).as_deref(), Some(token.as_bytes()), "{left:?}");
    }
    let unsupported = format!("{screen}\x1b7Press Enter to retry.\r\n");
    assert!(matches!(capture_complete(&SecretBytes(unsupported.into_bytes())), Err(CaptureFailure::CliError)));
}

#[test]
fn setup_token_0915_r2_wide_han_does_not_hide_a_visible_competing_value() {
    let token = fake_token();
    let raw = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n{token}b\x1b[8m\u{9fff}\x1b[28m\r\n");
    assert_eq!(setup_0915_final(raw).as_deref(), None);
}

#[test]
fn setup_token_0915_r2_wide_han_can_be_replaced_by_an_ascii_cell() {
    let token = fake_token();
    let raw = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n\u{9fff}\r!\r\n");
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));
}

#[test]
fn setup_token_0915_r2_ambiguous_concealed_cells_do_not_hide_a_competing_value() {
    let token = fake_token();
    let screen = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n");
    let competing = format!("{screen}{token}b\x1b[8m\u{2026}\x1b[28m\r\n");
    assert_eq!(setup_0915_final(competing).as_deref(), None);
    let same = format!("{screen}{token}\x1b[8m\u{2026}\x1b[28m\r\n");
    assert_eq!(setup_0915_final(same).as_deref(), Some(token.as_bytes()));
}

#[test]
fn setup_token_0915_r2_ignores_other_c0_bytes_in_an_ordinary_osc() {
    let token = fake_token();
    let screen = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n");
    for osc in [
        "\x1b]0;x\t\x07",
        "\x1b]0;x\x01\x08\x0b\x0c\r\n\x1f\x1b\\",
    ] {
        let raw = format!("{screen}{osc}");
        assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()), "{osc:?}");
    }
    for cancel in ['\x18', '\x1a'] {
        let raw = format!("{screen}\x1b]0;x{cancel}\x07\x1b[2J\x1b[H{screen}");
        assert_eq!(setup_0915_final(raw).as_deref(), None, "{cancel:?}");
    }
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r2_queues_a_code_that_arrives_while_confirming() {
    let (send_queue, receive_queue) = mpsc::channel();
    let token = fake_token();
    let candidate = format!("\x1b[2J\x1b[HYour OAuth token:\r\n{token}\r\n");
    let body = format!(r#"
code = b''
while not code.endswith(b'\r'): code += os.read(0, 256)
assert code == b'fixture-code#fixture-state\r'
os.write(1, b'\033[2J\033[HYour OAuth token:\r\n{token}\r\n')
"#);
    let mut queue = None;
    let mut submitted = None;
    let (saved, events) = run_0915_r2_stream(move |sender| {
        assert!(queue_0915_r2_data(sender, b"Enter the authorization code:\r\n"));
        send_queue.send(sender.clone()).unwrap();
    }, &body, RunOptions { timeout: Duration::from_secs(3), fallback_after: Duration::ZERO,
        token_exit_grace: Duration::from_millis(500), ..RunOptions::default() },
        |registry, event| match event.state {
            SetupTokenState::CodeAvailable if queue.is_none() => {
                let sender = receive_queue.try_recv().unwrap();
                assert!(queue_0915_r2_data(&sender, &candidate));
                queue = Some(sender);
            }
            SetupTokenState::Confirming if submitted.is_none() => {
                submitted = Some(registry.submit_code(&event.login_id, "fixture-code#fixture-state".into()));
                assert!(registry.submit_code(&event.login_id, "second#state".into()).is_err());
                assert!(queue_0915_r2_data(queue.as_ref().unwrap(),
                    b"\x1b[2J\x1b[HEnter the authorization code:\r\n"));
            }
            _ => {}
        });
    assert_eq!(submitted, Some(Ok(())));
    assert!(events.iter().any(|event| event.reason.as_deref() == Some("code_reopened")));
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[test]
fn setup_token_0915_r2_delayed_wrap_edits_need_a_full_row_erase() {
    let token = fake_token();
    let screen = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n");
    for edit in ["\x1b[K", "\x1b[J", "\x1b[?7l"] {
        let edited = format!("{screen}\x1b[2;512H!{edit}");
        let erased_last_cell = edit != "\x1b[?7l";
        let expected = erased_last_cell.then_some(token.as_bytes());
        assert_eq!(setup_0915_final(&edited).as_deref(), expected, "{edit:?}");
        let raw = format!("{edited} \r\n");
        assert_eq!(setup_0915_final(&raw).as_deref(), Some(token.as_bytes()), "{edit:?}");
        let repaired = format!("{edited}\x1b[2;1H\x1b[2K{token}");
        assert_eq!(setup_0915_final(repaired).as_deref(), Some(token.as_bytes()), "{edit:?}");
    }
}

#[test]
fn setup_token_0915_r2_last_column_does_not_leave_a_pending_wrap_when_disabled() {
    let raw = b"\x1b[?7l\x1b[1;512H!\x1b[?7hZ";
    let mut screen = Screen::default();
    screen.finish(raw, |_, _| false);
    let lines = screen.lines().unwrap();
    assert_eq!(lines[0].text.as_slice().last(), Some(&b'!'));
    assert_eq!(lines[1].text.as_slice(), b"Z");
}

#[test]
fn setup_token_0915_r2_deleting_the_heading_row_prevents_capture() {
    let token = fake_token();
    let raw = format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n\x1b[H\x1b[M");
    assert_eq!(setup_0915_final(raw).as_deref(), None);
}

#[test]
fn setup_token_0915_r2_rgb_blue_28_keeps_a_concealed_heading_hidden() {
    let token = fake_token();
    let raw = format!("\x1b[8;38;2;1;2;28mYour OAuth token:\r\n\x1b[0m{token}\r\n");
    assert_eq!(setup_0915_final(raw).as_deref(), None);
}

fn setup_0915_r3_display(token: &str) -> String {
    format!("Your OAuth token:\r\n{token}\r\nPress Enter to continue.\r\n")
}

#[test]
fn setup_token_0915_r3_wrap_toggle_keeps_the_other_rows_readable() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let safe = format!("{display}\x1b[4;512H!\x1b[?7l");
    assert_eq!(setup_0915_final(safe).as_deref(), Some(token.as_bytes()));

    let blocks = format!("{display}\x1b[2;512H!\x1b[?7l");
    assert_eq!(setup_0915_final(blocks).as_deref(), None);
}

#[test]
fn setup_token_0915_r3_full_width_erasure_recovers_the_row() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let raw = format!("\x1b[2;512H!\x1b[K\x1b[2;1H\x1b[K\x1b[H{display}");
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));

    let uncertain = "\x1b[2;1H\u{2026}\x1b[2;5H!";
    for erase in ["2;1H\x1b[K", "2;512H\x1b[1K", "2;1H\x1b[512X",
        "2;1H\x1b[513X", "2;1H\x1b[2K", "2;1H\x1b[J", "2;512H\x1b[1J"] {
        let raw = format!("{uncertain}\x1b[{erase}\x1b[H{display}");
        assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()), "{erase:?}");
    }
    let partial = format!("{uncertain}\x1b[2;1H\x1b[511X\x1b[H{display}");
    assert_eq!(setup_0915_final(partial).as_deref(), None);
}

#[test]
fn setup_token_0915_r3_next_and_previous_line_anchor_the_column() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let raw = format!("\x1b[2;512H!\x1b[K\x1b[2J\x1b[F{display}");
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));

    for (anchored, relative) in [("E", "B"), ("F", "A")] {
        let prefix = "\x1b[2;1H\u{2026}\x1b[2J";
        let raw = format!("{prefix}\x1b[{anchored}{display}");
        assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()), "{anchored}");
        let raw = format!("{prefix}\x1b[{relative}{display}");
        assert_eq!(setup_0915_final(raw).as_deref(), None, "{relative}");
    }
}

#[test]
fn setup_token_0915_r3_moving_an_uncertain_cursor_preserves_erased_rows() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let raw = format!("\x1b[4;512H!\x1b[Kx\x1b[2J\r\n\x1b[H{display}");
    assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()));

    let uncertain = "\x1b[4;512H\u{2026}";
    for movement in ["\r\n", "\x1b[L", "\x1b[M"] {
        let blank = format!("{uncertain}\x1b[2J{movement}\x1b[H{display}");
        assert_eq!(setup_0915_final(blank).as_deref(), Some(token.as_bytes()), "{movement:?}");
        let uncleared = format!("{uncertain}{movement}\x1b[H{display}");
        assert_eq!(setup_0915_final(uncleared).as_deref(), None, "{movement:?}");
    }
}

#[test]
fn setup_token_0915_r3_underline_color_eight_leaves_the_heading_visible() {
    let token = fake_token();
    for color in ["58;5;8", "58;2;0;28;8", "58:5:8", "58:2::0:28:8", "59"] {
        let raw = format!("\x1b[{color}mYour OAuth token:\x1b[0m\r\n{token}\r\nPress Enter to continue.\r\n");
        assert_eq!(setup_0915_final(raw).as_deref(), Some(token.as_bytes()), "{color}");
    }
}

#[test]
fn setup_token_0915_r3_underline_color_twenty_eight_keeps_the_cell_hidden() {
    for color in ["58;5;28", "58;2;1;2;28", "58:5:28", "58:2::1:2:28", "59"] {
        let raw = format!("\x1b[8m\x1b[{color}mA\x1b[59;28mZ");
        let mut screen = Screen::default();
        screen.finish(raw.as_bytes(), |_, _| false);
        assert_eq!(screen.lines().unwrap()[0].text.as_slice(), b" Z", "{color}");
    }
}

#[test]
fn setup_token_0915_r3_oauth_error_matches_the_visible_prefix_after_a_tab() {
    for ending in ["\r\n", ""] {
        let raw = format!("OAuth error:\tinvalid grant{ending}");
        assert!(matches!(capture_complete(&SecretBytes(raw.into_bytes())), Err(CaptureFailure::CliError)));
    }

    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let separated = format!("{display}OAuth \x1b[8Gerror:\tinvalid grant\r\n");
    assert_eq!(setup_0915_final(separated).as_deref(), Some(token.as_bytes()));
}

#[test]
fn setup_token_0915_r3_wide_han_occupies_two_cells() {
    let raw = b"\xe9\xbf\xbfZ\x1b[2G!";
    let mut screen = Screen::default();
    screen.finish(raw, |_, _| false);
    assert_eq!(screen.lines().unwrap()[0].text.as_slice(), b" !Z");
}

#[cfg(unix)]
fn queue_0915_r3_titles(
    sender: SyncSender<PtyOutput>,
    input_received: PathBuf,
    titles_closed: PathBuf,
    afterward: String,
) {
    assert!(queue_0915_r2_data(&sender, b"\x1b]0;x"));
    std::thread::spawn(move || {
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(60));
            if input_received.is_file() {
                if queue_0915_r2_data(&sender, format!("\x07{afterward}")) {
                    fs::write(&titles_closed, b"").unwrap();
                }
                return;
            }
            if !queue_0915_r2_data(&sender, b"\x07\x1b]0;x") {
                return;
            }
        }
    });
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r3_confirms_across_consecutive_split_titles() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let markers = tempfile::tempdir().unwrap();
    let entered = markers.path().join("enter-received");
    let closed = markers.path().join("titles-closed");
    let body = format!(r#"
assert os.read(0, 1) == b'\r'
open({entered:?}, 'w').close()
while not os.path.exists({closed:?}): time.sleep(0.005)
"#, entered = entered.to_str().unwrap(), closed = closed.to_str().unwrap());
    let (send_queue, receive_queue) = mpsc::channel();
    let mut titles = Some((entered, closed));
    let (saved, events) = run_0915_r2_stream(move |sender| {
        assert!(queue_0915_r2_data(sender, display));
        send_queue.send(sender.clone()).unwrap();
    }, &body, RunOptions {
        timeout: Duration::from_secs(2),
        token_exit_grace: Duration::from_millis(350),
        ..RunOptions::default()
    }, |_, event| {
        if event.state == SetupTokenState::Confirming {
            if let Some((entered, closed)) = titles.take() {
                queue_0915_r3_titles(receive_queue.try_recv().unwrap(), entered, closed, String::new());
            }
        }
    });
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r3_terminates_the_code_across_consecutive_split_titles() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let markers = tempfile::tempdir().unwrap();
    let entered = markers.path().join("code-received");
    let closed = markers.path().join("titles-closed");
    let body = format!(r#"
code = b''
while not code.endswith(b'\r'):
    chunk = os.read(0, 4096)
    if not code: first = time.monotonic()
    code += chunk
assert code == b'x#y\r'
assert time.monotonic() - first >= 0.13
open({entered:?}, 'w').close()
while not os.path.exists({closed:?}): time.sleep(0.005)
"#, entered = entered.to_str().unwrap(), closed = closed.to_str().unwrap());
    let (send_queue, receive_queue) = mpsc::channel();
    let mut titles = Some((entered, closed, format!("\x1b[2J\x1b[H{display}")));
    let (saved, events) = run_0915_r2_stream(move |sender| {
        assert!(queue_0915_r2_data(sender, b"Code:\r\n"));
        send_queue.send(sender.clone()).unwrap();
    }, &body, RunOptions {
        timeout: Duration::from_secs(2),
        fallback_after: Duration::ZERO,
        ..RunOptions::default()
    }, |registry, event| {
        if event.state == SetupTokenState::CodeAvailable {
            if let Some((entered, closed, afterward)) = titles.take() {
                registry.submit_code(&event.login_id, "x#y".into()).unwrap();
                queue_0915_r3_titles(receive_queue.try_recv().unwrap(), entered, closed, afterward);
            }
        }
    });
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r3_recognizes_osc_133_before_its_terminator() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let markers = tempfile::tempdir().unwrap();
    let reopened = markers.path().join("code-reopened");
    let body = format!(r#"
from select import select
while not os.path.exists({reopened:?}):
    assert not select([0], [], [], 0.01)[0], 'Enter sent during OSC 133'
"#, reopened = reopened.to_str().unwrap());
    let (send_queue, receive_queue) = mpsc::channel();
    let mut sender = None;
    let (saved, events) = run_0915_r2_stream(move |queue| {
        assert!(queue_0915_r2_data(queue, display));
        send_queue.send(queue.clone()).unwrap();
    }, &body, RunOptions {
        timeout: Duration::from_secs(2),
        token_exit_grace: Duration::from_millis(300),
        ..RunOptions::default()
    }, |_, event| {
        if event.state == SetupTokenState::Confirming {
            let queue = receive_queue.try_recv().unwrap();
            assert!(queue_0915_r2_data(&queue, b"\x1b]133;A"));
            sender = Some(queue);
        } else if event.reason.as_deref() == Some("code_reopened") {
            assert!(queue_0915_r2_data(sender.as_ref().unwrap(), b"\x07"));
            fs::write(&reopened, b"").unwrap();
        }
    });
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("capture_failed"));
    assert!(reopened.is_file());
    assert_eq!(saved.as_bytes(), format!("{token}b").as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r3_a_new_candidate_with_pending_csi_holds_the_code() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let (send_queue, receive_queue) = mpsc::channel();
    let mut first = Some(format!("\x1b[2J\x1b[H{display}\x1b[?25"));
    let (saved, events) = run_0915_r2_stream(move |sender| {
        assert!(queue_0915_r2_data(sender, b"Code:\r\n"));
        send_queue.send(sender.clone()).unwrap();
    }, "assert os.read(0, 1) == b'\\r'", RunOptions {
        timeout: Duration::from_secs(3),
        fallback_after: Duration::ZERO,
        token_exit_grace: Duration::from_millis(350),
        ..RunOptions::default()
    }, |registry, event| {
        if event.state == SetupTokenState::CodeAvailable {
            if let Some(first) = first.take() {
                registry.submit_code(&event.login_id, "x#y".into()).unwrap();
                let sender = receive_queue.try_recv().unwrap();
                assert!(queue_0915_r2_data(&sender, first));
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(120));
                    queue_0915_r2_data(&sender, b"h");
                });
            }
        }
    });
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r3_queued_code_waits_for_csi_or_escape_without_a_candidate() {
    for (prefix, suffix) in [(b"\x1b[?25".as_slice(), b"h".as_slice()),
        (b"\x1b".as_slice(), b"[?25h".as_slice())] {
        let token = fake_token();
        let display = setup_0915_r3_display(&token);
        let markers = tempfile::tempdir().unwrap();
        let finished = markers.path().join("escape-finished");
        let body = format!(r#"
code = os.read(0, 1)
assert os.path.exists({finished:?}), 'code sent before the escape finished'
while not code.endswith(b'\r'): code += os.read(0, 256)
assert code == b'x#y\r'
os.write(1, bytes({display:?}))
"#, finished = finished.to_str().unwrap(), display = display.as_bytes());
        let (send_queue, receive_queue) = mpsc::channel();
        let mut marker = Some(finished);
        let (saved, events) = run_0915_r2_stream(move |sender| {
            assert!(queue_0915_r2_data(sender, b"Code:\r\n"));
            send_queue.send(sender.clone()).unwrap();
        }, &body, RunOptions {
            timeout: Duration::from_secs(3),
            fallback_after: Duration::ZERO,
            ..RunOptions::default()
        }, |registry, event| {
            if event.state == SetupTokenState::CodeAvailable {
                if let Some(marker) = marker.take() {
                    registry.submit_code(&event.login_id, "x#y".into()).unwrap();
                    let sender = receive_queue.try_recv().unwrap();
                    assert!(queue_0915_r2_data(&sender, prefix));
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(120));
                        let _ = fs::write(&marker, b"");
                        queue_0915_r2_data(&sender, suffix);
                    });
                }
            }
        });
        assert_eq!(events.last().unwrap().state, SetupTokenState::Saved, "{prefix:?}");
        assert_eq!(saved.as_bytes(), token.as_bytes());
    }
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r3_does_not_pair_a_diagnostic_with_a_different_unfinished_row() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let first = format!("{display}Press Enter \x1b[14Gto retry\r\n");
    let (saved, events) = run_0915_r2_stream(move |sender| {
        assert!(queue_0915_r2_data(sender, first));
        let sender = sender.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            if queue_0915_r2_data(&sender, b"Press Enter \x1b[13Gto retry") {
                std::thread::sleep(Duration::from_millis(120));
                queue_0915_r2_data(&sender, b" later.\r\n");
            }
        });
    }, "assert os.read(0, 1) == b'\\r'", RunOptions {
        timeout: Duration::from_secs(3),
        token_exit_grace: Duration::from_millis(480),
        ..RunOptions::default()
    }, |_, _| {});
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[test]
fn setup_token_0915_r3_diagnoses_the_retry_only_if_the_lf_or_eof_row_matches() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    for ending in ["\r\n", ""] {
        let visible = format!("{display}Press Enter \x1b[13Gto retry{ending}");
        assert!(matches!(capture_complete(&SecretBytes(visible.into_bytes())), Err(CaptureFailure::CliError)),
            "ending: {ending:?}");

        let separated = format!("{display}Press Enter \x1b[14Gto retry{ending}");
        assert_eq!(setup_0915_final(separated).as_deref(), Some(token.as_bytes()), "ending: {ending:?}");
    }
    let old_diagnostic = format!("{display}Press Enter \x1b[14Gto retry\r\nPress Enter \x1b[13Gto retry later.\r\n");
    assert_eq!(setup_0915_final(old_diagnostic).as_deref(), Some(token.as_bytes()));
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r3_restarts_grace_when_cells_disappear_before_an_incomplete_csi() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let first = display.clone();
    let markers = tempfile::tempdir().unwrap();
    let restored = markers.path().join("display-restored");
    let body = format!(r#"
assert os.read(0, 1) == b'\r'
assert time.time() - os.stat({restored:?}).st_mtime >= 0.45, 'old confirmation deadline'
"#, restored = restored.to_str().unwrap());
    let (send_queue, receive_queue) = mpsc::channel();
    let mut reappearance = Some((restored, format!("h\x1b[2J\x1b[H{display}")));
    let (saved, events) = run_0915_r2_stream(move |sender| {
        assert!(queue_0915_r2_data(sender, first));
        send_queue.send(sender.clone()).unwrap();
    }, &body, RunOptions {
        timeout: Duration::from_secs(3),
        token_exit_grace: Duration::from_millis(500),
        ..RunOptions::default()
    }, |_, event| {
        if event.state == SetupTokenState::Confirming {
            if let Some((restored, display)) = reappearance.take() {
                let sender = receive_queue.try_recv().unwrap();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(290));
                    if queue_0915_r2_data(&sender, b"\x1b[2J\x1b[HCode:\r\n\x1b[?25") {
                        std::thread::sleep(Duration::from_millis(315));
                        fs::write(restored, b"").unwrap();
                        queue_0915_r2_data(&sender, display);
                    }
                });
            }
        }
    });
    assert_eq!(events.iter().filter(|event| event.state == SetupTokenState::Confirming).count(), 2);
    assert_eq!(events.iter().filter(|event| event.reason.as_deref() == Some("code_reopened")).count(), 1);
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r3_closes_the_code_form_before_writing_confirmation() {
    struct SubmitAfterEnter<F> {
        writer: Box<dyn Write + Send>,
        submit: Option<F>,
    }

    impl<F: FnOnce()> Write for SubmitAfterEnter<F> {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            let written = self.writer.write(data)?;
            if written == 1 && data == b"\r" {
                self.submit.take().unwrap()();
            }
            Ok(written)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.writer.flush()
        }
    }

    let token = fake_token();
    let display = format!("\x1b[2J\x1b[H{}", setup_0915_r3_display(&token));
    let (send_queue, receive_queue) = mpsc::channel();
    let (send_result, receive_result) = mpsc::channel();
    let mut display = Some(display);
    let (saved, events) = run_0915_stream_with_pty(move |sender| {
        assert!(queue_0915_r2_data(sender, b"Code:\r\n"));
        send_queue.send(sender.clone()).unwrap();
    }, "assert os.read(0, 1) == b'\\r'", RunOptions {
        timeout: Duration::from_secs(6),
        fallback_after: Duration::ZERO,
        token_exit_grace: Duration::from_millis(200),
        ..RunOptions::default()
    }, |_, event| {
        if event.state == SetupTokenState::CodeAvailable {
            if let Some(display) = display.take() {
                let sender = receive_queue.try_recv().unwrap();
                assert!(queue_0915_r2_data(&sender, display));
            }
        }
    }, |registry, login_id, pty| {
        let registry = registry.clone();
        let login_id = login_id.to_owned();
        let writer = std::mem::replace(&mut pty.writer, Box::new(std::io::sink()));
        pty.writer = Box::new(SubmitAfterEnter {
            writer,
            submit: Some(move || {
                send_result.send(registry.submit_code(&login_id, "x#y".into())).unwrap();
            }),
        });
    });
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(receive_result.try_recv().unwrap(), Err(UNAVAILABLE.to_string()));
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

#[cfg(unix)]
#[test]
fn setup_token_0915_r3_drains_a_queued_erase_after_a_completed_error() {
    let token = fake_token();
    let display = setup_0915_r3_display(&token);
    let (saved, events) = run_0915_r2_stream(move |sender| {
        assert!(queue_0915_r2_data(sender, b"Press Enter to retry\r\n"));
        assert!(queue_0915_r2_data(sender, format!("\x1b[2J\x1b[H{display}")));
    }, "pass", RunOptions::default(), |_, _| {});
    assert_eq!(events.last().unwrap().state, SetupTokenState::Saved);
    assert_eq!(saved.as_bytes(), token.as_bytes());
}

async fn setup_l0d_log<T>(run: impl FnOnce() -> T) -> (T, String) {
    let logs = tempfile::tempdir().unwrap();
    let result = crate::diag::with_test_dir(logs.path().to_path_buf(), async { run() }).await;
    let log = match fs::read_to_string(logs.path().join("diag.log")) {
        Ok(log) => log,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => panic!("could not read fixture diagnostic: {error}"),
    };
    (result, log)
}

fn setup_l0d_messages(log: &str) -> Vec<&str> {
    log.lines()
        .filter_map(|line| line.split_once("[claude_setup_token] ").map(|(_, message)| message))
        .collect()
}

fn setup_l0d_check_line(line: &str, outcome: &str, reason: &str, expected: &[(&str, &str)]) {
    let fields: HashMap<_, _> = line.split_ascii_whitespace()
        .map(|part| part.split_once('=').expect("diagnostic field"))
        .collect();
    assert_eq!(fields.len(), 13, "diagnostic field count");
    assert_eq!(line.split_ascii_whitespace().count(), fields.len(), "duplicate field");
    assert_eq!(fields["outcome"], outcome);
    assert_eq!(fields["reason"], reason);
    assert_eq!(fields["os"], std::env::consts::OS);
    for key in ["received_bytes", "visible_rows", "value_rows", "heading_rows", "elapsed_s"] {
        assert!(fields[key].parse::<usize>().is_ok(), "numeric field {key}");
    }
    assert!(matches!(fields["enter_sent"], "true" | "false"));
    assert!(matches!(fields["code_accepted"], "true" | "false"));
    assert!(!fields["control"].is_empty());
    assert!(fields["exit_code"] == "none" || fields["exit_code"].parse::<u32>().is_ok());
    assert!(!fields["previous_reason"].is_empty());
    for &(key, value) in expected {
        assert_eq!(fields[key], value, "diagnostic field {key}");
    }
}

fn setup_l0d_expect_line<'a>(log: &'a str, outcome: &str, reason: &str, expected: &[(&str, &str)]) -> &'a str {
    let messages = setup_l0d_messages(log);
    assert_eq!(messages.len(), 1, "expected one setup-token terminal diagnostic");
    let line = messages[0];
    setup_l0d_check_line(line, outcome, reason, expected);
    line
}

#[cfg(unix)]
async fn setup_l0d_screen_attempt(raw: impl AsRef<[u8]>) -> String {
    let raw = raw.as_ref().to_vec();
    let ((saved, events), log) = setup_l0d_log(|| run_0915_r2_stream(move |sender| {
        assert!(queue_0915_r2_data(sender, raw));
        assert!(sender.send(PtyOutput::Eof).is_ok());
    }, "time.sleep(15)", RunOptions::default(), |_, _| {})).await;
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("capture_failed"));
    assert_eq!(saved, format!("{}b", fake_token()));
    log
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_no_heading_excludes_secrets() {
    let token = fake_token();
    let url = "https://example.test/oauth/authorize?state=private-fixture";
    let mail = "person@example.test";
    let raw = format!("Open {url}\r\nPrivate account {mail}\r\n{token}\r\n");
    let bytes = raw.len().to_string();
    let log = setup_l0d_screen_attempt(raw).await;
    let line = setup_l0d_expect_line(&log, "capture_failed", "no_heading", &[
        ("received_bytes", &bytes), ("visible_rows", "3"), ("value_rows", "1"), ("heading_rows", "0"),
        ("enter_sent", "false"), ("code_accepted", "false"),
    ]);
    for secret in [token.as_str(), &token[..8], url, mail, "Private account", ID, "private-fixture"] {
        assert!(!log.contains(secret), "private fixture data in diag.log");
    }
    println!("no_heading_omits_fixture_data: [claude_setup_token] {line}");
}

macro_rules! l0d_screen_case {
    ($name:ident, |$token:ident| $raw:expr, $reason:literal $(, $key:literal = $value:literal)* $(,)?) => {
        #[cfg(unix)]
        #[tokio::test]
        async fn $name() {
            let $token = fake_token();
            let log = setup_l0d_screen_attempt($raw).await;
            setup_l0d_expect_line(&log, "capture_failed", $reason, &[$(($key, $value)),*]);
        }
    };
}

l0d_screen_case!(setup_token_l0d_value_line_not_token,
    |_token| "Your OAuth token:\r\nsk-ant-\r\n", "value_line_not_token", "value_rows" = "1");
l0d_screen_case!(setup_token_l0d_value_line_col512,
    |token| format!("Your OAuth token:\r\n{}{token}\r\n", " ".repeat(512 - token.len())),
    "value_line_col512");
l0d_screen_case!(setup_token_l0d_heading_col512,
    |token| format!("\x1b[1;496HYour OAuth token:\r\n{token}\r\n"), "heading_col512");
l0d_screen_case!(setup_token_l0d_below_not_blank_or_hint,
    |token| format!("Your OAuth token:\r\n{token}\r\nabcdef\r\n"), "below_not_blank_or_hint");
l0d_screen_case!(setup_token_l0d_value_on_last_row,
    |token| format!("\x1b[39;1HYour OAuth token:\r\n{token}\x1b[A"), "value_on_last_row");
l0d_screen_case!(setup_token_l0d_conflicting_value_lines,
    |token| format!("Your OAuth token:\r\n{token}\r\n\r\n{token}b"), "conflicting_value_lines", "value_rows" = "2");
l0d_screen_case!(setup_token_l0d_uncertain_row,
    |token| format!("Your OAuth token:\r\n{token}\r\nPress Enter\u{2026}\r!"), "uncertain_row");
l0d_screen_case!(setup_token_l0d_ambiguous_width_value_row,
    |token| format!("Your OAuth token:\r\n{token}\x1b[8m\u{2026}\x1b[28m"), "uncertain_row");

l0d_screen_case!(setup_token_l0d_uncertain_screen_csi_r,
    |token| format!("Your OAuth token:\r\n{token}\r\n\x1b[1;2r"), "uncertain_screen", "control" = "csi_r");
l0d_screen_case!(setup_token_l0d_uncertain_screen_alt_screen,
    |_token| "\x1b[?1049h", "uncertain_screen", "control" = "alt_screen");
l0d_screen_case!(setup_token_l0d_uncertain_screen_c1,
    |_token| b"\x9b".as_slice(), "uncertain_screen", "control" = "c1");
l0d_screen_case!(setup_token_l0d_uncertain_screen_c0,
    |_token| b"\x0b".as_slice(), "uncertain_screen", "control" = "c0");
l0d_screen_case!(setup_token_l0d_uncertain_screen_escape,
    |_token| "\x1b7", "uncertain_screen", "control" = "escape");
l0d_screen_case!(setup_token_l0d_uncertain_screen_csi,
    |_token| "\x1b[4h", "uncertain_screen", "control" = "csi");
l0d_screen_case!(setup_token_l0d_uncertain_screen_osc,
    |_token| "\x1b]0;title\x1b?", "uncertain_screen", "control" = "osc");
l0d_screen_case!(setup_token_l0d_uncertain_screen_osc133,
    |_token| "\x1b]133;A\x07", "uncertain_screen", "control" = "osc_133");
l0d_screen_case!(setup_token_l0d_uncertain_screen_incomplete_sequence,
    |token| format!("Your OAuth token:\r\n{token}\r\n\x1b[?"), "uncertain_screen", "control" = "incomplete_sequence");

macro_rules! l0d_fake_cli_case {
    ($name:ident, $mode:literal, $outcome:literal, $reason:literal $(, $key:literal = $value:literal)* $(,)?) => {
        #[cfg(unix)]
        #[tokio::test]
        async fn $name() {
            let ((_, _, events, _), log) = setup_l0d_log(|| run_fake($mode, false)).await;
            assert_eq!(events.last().unwrap().reason.as_deref(), Some($outcome));
            let line = setup_l0d_expect_line(&log, $outcome, $reason, &[$(($key, $value)),*]);
            println!("[claude_setup_token] {line}");
        }
    };
}

l0d_fake_cli_case!(setup_token_l0d_cli_error, "error", "cli_error", "cli_error");
l0d_fake_cli_case!(setup_token_l0d_child_exit, "bad_exit", "cli_error", "child_exit", "exit_code" = "1");
l0d_fake_cli_case!(setup_token_l0d_timeout, "timeout", "timeout", "timeout");
l0d_fake_cli_case!(setup_token_l0d_cancelled, "cancel", "cancelled", "cancelled");

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_output_limit_counts_overflow_chunk() {
    let ((_, _, events, audit), log) = setup_l0d_log(|| run_fake("overflow", false)).await;
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("output_limit"));
    assert!(audit.wiped_buffer.len() <= OUTPUT_LIMIT);
    let line = setup_l0d_expect_line(&log, "output_limit", "output_limit", &[]);
    let received = line.split_ascii_whitespace().find_map(|part| part.strip_prefix("received_bytes="))
        .unwrap().parse::<usize>().unwrap();
    assert!(received > OUTPUT_LIMIT);
    println!("[claude_setup_token] {line}");
}

#[tokio::test]
async fn setup_token_l0d_launch_failed() {
    let (_, log) = setup_l0d_log(setup_token_spawn_failure_releases_the_single_attempt_and_cleans_staging).await;
    setup_l0d_expect_line(&log, "launch_failed", "launch_failed", &[
        ("received_bytes", "0"), ("visible_rows", "0"), ("code_accepted", "false"),
    ]);
}

#[tokio::test]
async fn setup_token_l0d_cancelled_before_spawn() {
    let (_, log) = setup_l0d_log(setup_token_cancelled_before_spawn_never_runs_the_command).await;
    setup_l0d_expect_line(&log, "cancelled", "cancelled", &[("received_bytes", "0"), ("enter_sent", "false")]);
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_confirmation_failed() {
    let (_, log) = setup_l0d_log(setup_token_failed_confirmation_requires_a_clean_natural_exit).await;
    setup_l0d_expect_line(&log, "capture_failed", "confirmation_failed", &[("enter_sent", "false")]);
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_output_incomplete() {
    let ((_, events), log) = setup_l0d_log(|| run_0915_r2_stream(|sender| {
        assert!(queue_0915_r2_data(sender, b"Notice.\r\n"));
        assert!(sender.send(PtyOutput::ReadFailed).is_ok());
    }, "time.sleep(15)", RunOptions::default(), |_, _| {})).await;
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("capture_failed"));
    setup_l0d_expect_line(&log, "capture_failed", "output_incomplete", &[
        ("received_bytes", "9"), ("visible_rows", "1"),
    ]);
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_child_wait_failed() {
    #[derive(Debug)]
    struct RejectWait(Box<dyn Child + Send + Sync>);

    impl portable_pty::ChildKiller for RejectWait {
        fn kill(&mut self) -> std::io::Result<()> { self.0.kill() }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> { self.0.clone_killer() }
    }

    impl Child for RejectWait {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> { Err(std::io::ErrorKind::Other.into()) }
        fn wait(&mut self) -> std::io::Result<ExitStatus> { self.0.wait() }
        fn process_id(&self) -> Option<u32> { self.0.process_id() }
    }

    let ((_, events), log) = setup_l0d_log(|| run_0915_stream_with_pty(
        |_| {}, "time.sleep(15)", RunOptions::default(), |_, _| {},
        |_, _, pty| {
            let mut child: Box<dyn Child + Send + Sync> = Box::new(std::process::Command::new("/usr/bin/true").spawn().unwrap());
            child.wait().unwrap();
            std::mem::swap(&mut pty.child, &mut child);
            pty.child = Box::new(RejectWait(child));
        },
    )).await;
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("capture_failed"));
    setup_l0d_expect_line(&log, "capture_failed", "child_wait_failed", &[]);
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_stop_unconfirmed_preserves_previous_reason() {
    let (base, cmd, live) = fixture("exit");
    let registry = SetupTokenRegistry::default();
    let (initial, mut control) = registry.begin(ID).unwrap();
    let login = initial.login_id.clone();
    control.queue_output = Some(Box::new(|sender| { assert!(sender.send(PtyOutput::Eof).is_ok()); }));
    let (audit, log) = setup_l0d_log(|| run_attempt_with_pty(&registry, initial, control, base.path(), &live, cmd,
        RunOptions::default(), &MemoryStore::default(), |_| panic!("must not check owner"),
        |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {},
        |pty| {
            assert!(pty.child.wait().unwrap().success());
            pty.stopped = Some(false);
            registry.cancel(&login).unwrap();
        }, drop,
    )).await;
    assert!(!audit.child_stopped);
    assert_eq!(registry.current().unwrap().unwrap().reason.as_deref(), Some("capture_failed"));
    setup_l0d_expect_line(&log, "capture_failed", "stop_unconfirmed", &[("previous_reason", "cancelled")]);
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_save_failed_from_store() {
    struct FailingStore;
    impl LaunchTokenStore for FailingStore {
        fn read(&self, _: &str) -> Result<Option<String>, String> { Err("fixture private store error".into()) }
        fn write(&self, _: &str, _: &str) -> Result<(), String> { panic!("must not write") }
        fn delete(&self, _: &str) -> Result<(), String> { panic!("must not delete") }
    }
    let (base, cmd, live) = fixture("success");
    let registry = SetupTokenRegistry::default();
    let (initial, control) = registry.begin(ID).unwrap();
    let (_, log) = setup_l0d_log(|| run_attempt(&registry, initial, control, base.path(), &live, cmd,
        RunOptions::default(), &FailingStore, |_| owner(false),
        |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {},
    )).await;
    assert_eq!(registry.current().unwrap().unwrap().reason.as_deref(), Some("save_failed"));
    setup_l0d_expect_line(&log, "save_failed", "save_failed", &[("value_rows", "1"), ("heading_rows", "1")]);
    assert!(!log.contains("fixture private store error"));
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_save_failed_on_unwind() {
    let (_, log) = setup_l0d_log(setup_token_panic_emits_failure_releases_attempt_and_cleans_staging).await;
    setup_l0d_expect_line(&log, "save_failed", "save_failed", &[("value_rows", "1")]);
    assert!(!log.contains("fixture owner panic"));
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_owner_mismatch() {
    let (_, log) = setup_l0d_log(setup_token_fake_cli_owner_mismatch_never_saves_the_new_token).await;
    setup_l0d_expect_line(&log, "owner_mismatch", "owner_mismatch", &[]);
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_replacement_unverified() {
    let (_, log) = setup_l0d_log(setup_token_0915_weak_owner_checks_keep_the_saved_value_before_both_writes).await;
    let messages = setup_l0d_messages(&log);
    assert_eq!(messages.len(), 4);
    for line in messages {
        setup_l0d_check_line(line, "replacement_unverified", "replacement_unverified", &[]);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_tracks_code_acceptance_and_confirmation_enter() {
    let token = fake_token();
    let body = format!(r#"
code = b''
while not code.endswith(b'\r'):
    code += os.read(0, 64)
assert code == b'fixture-code#fixture-state\r'
os.write(1, b'Your OAuth token:\r\n{token}\r\n')
assert os.read(0, 1) == b'\r'
os.write(1, b'\033[2J\033[HFinished.\r\n')
"#);
    let ((saved, events), log) = setup_l0d_log(|| run_0915_r2_stream(|sender| {
        assert!(queue_0915_r2_data(sender, b"Code:\r\n"));
    }, &body, RunOptions {
        timeout: Duration::from_secs(10), fallback_after: Duration::ZERO,
        token_exit_grace: Duration::from_millis(50), ..RunOptions::default()
    }, |registry, event| {
        if event.state == SetupTokenState::CodeAvailable {
            registry.submit_code(&event.login_id, "fixture-code#fixture-state".into()).unwrap();
        }
    })).await;
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("capture_failed"));
    assert_eq!(saved, format!("{token}b"));
    let line = setup_l0d_expect_line(&log, "capture_failed", "no_heading", &[
        ("visible_rows", "1"), ("value_rows", "0"), ("heading_rows", "0"),
        ("enter_sent", "true"), ("code_accepted", "true"),
    ]);
    assert!(!log.contains("fixture-code"));
    println!("[claude_setup_token] {line}");
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix2_timeout_retains_unsupported_control() {
    for (body, reason, control, bytes) in [
        ("os.read(0, 1)", "timeout", "none", "0"),
        ("os.write(1, b'\\033[?1049h')\nos.read(0, 1)", "uncertain_screen", "alt_screen", "8"),
    ] {
        let ((saved, events), log) = setup_l0d_log(|| run_0915_r2_stream(
            |_| {}, body, RunOptions { timeout: Duration::from_secs(1), ..RunOptions::default() }, |_, _| {},
        )).await;
        assert_eq!(events.last().unwrap().state, SetupTokenState::Timeout);
        assert_eq!(events.last().unwrap().reason.as_deref(), Some("timeout"));
        assert_eq!(saved, format!("{}b", fake_token()));
        let line = setup_l0d_expect_line(&log, "timeout", reason, &[
            ("received_bytes", bytes), ("control", control), ("enter_sent", "false"),
        ]);
        println!("[claude_setup_token] {line}");
    }
}

#[cfg(unix)]
async fn expect_l0d_code_write_failure(reject: &'static [u8]) {
    struct RejectWrite {
        writer: Box<dyn Write + Send>,
        reject: &'static [u8],
        attempted: Arc<AtomicBool>,
    }

    impl Write for RejectWrite {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes == self.reject {
                self.attempted.store(true, Ordering::SeqCst);
                return Err(std::io::ErrorKind::BrokenPipe.into());
            }
            self.writer.write(bytes)
        }

        fn flush(&mut self) -> std::io::Result<()> { self.writer.flush() }
    }

    const CODE: &str = "fixture-code#fixture-state";
    let attempted = Arc::new(AtomicBool::new(false));
    let ((saved, events), log) = setup_l0d_log(|| run_0915_stream_with_pty(
        |_| {}, "os.read(0, 256)\ntime.sleep(15)",
        RunOptions { timeout: Duration::from_secs(5), fallback_after: Duration::ZERO, ..RunOptions::default() },
        |registry, event| {
            if event.state == SetupTokenState::CodeAvailable {
                registry.submit_code(&event.login_id, CODE.into()).unwrap();
            }
        }, |_, _, pty| {
            let writer = std::mem::replace(&mut pty.writer, Box::new(std::io::sink()));
            pty.writer = Box::new(RejectWrite { writer, reject, attempted: attempted.clone() });
        },
    )).await;
    assert!(attempted.load(Ordering::SeqCst));
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("cli_error"));
    assert_eq!(saved, format!("{}b", fake_token()));
    let line = setup_l0d_expect_line(&log, "cli_error", "code_write_failed", &[
        ("code_accepted", "true"), ("enter_sent", "false"), ("received_bytes", "0"),
    ]);
    assert!(!log.contains(CODE));
    println!("[claude_setup_token] {line}");
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix2_code_body_write_failed() {
    expect_l0d_code_write_failure(b"fixture-code#fixture-state").await;
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix2_code_enter_write_failed() {
    expect_l0d_code_write_failure(b"\r").await;
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix2_stop_unconfirmed_retains_child_exit() {
    let (base, _, live) = fixture("exit");
    let registry = SetupTokenRegistry::default();
    let (initial, mut control) = registry.begin(ID).unwrap();
    control.queue_output = Some(Box::new(|sender| { assert!(sender.send(PtyOutput::Eof).is_ok()); }));
    let command = setup_0915_python(base.path(), "sys.exit(7)");
    let (audit, log) = setup_l0d_log(|| run_attempt_with_pty(&registry, initial, control, base.path(), &live, command,
        RunOptions::default(), &MemoryStore::default(), |_| panic!("must not check owner"),
        |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {},
        |pty| {
            assert_eq!(pty.child.wait().unwrap().exit_code(), 7);
            pty.stopped = Some(false);
        }, drop,
    )).await;
    assert!(!audit.child_stopped);
    assert_eq!(registry.current().unwrap().unwrap().reason.as_deref(), Some("capture_failed"));
    let line = setup_l0d_expect_line(&log, "capture_failed", "stop_unconfirmed", &[
        ("previous_reason", "child_exit"), ("exit_code", "7"),
    ]);
    println!("[claude_setup_token] {line}");
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix2_confirmation_flush_failure_leaves_enter_unsent() {
    struct UnflushedConfirmation {
        _writer: Box<dyn Write + Send>,
        buffered: bool,
    }

    impl Write for UnflushedConfirmation {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            assert_eq!(bytes, b"\r");
            self.buffered = true;
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            assert!(self.buffered);
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
    }

    let raw = format!("Your OAuth token:\r\n{}\r\n", fake_token());
    let ((saved, events), log) = setup_l0d_log(|| run_0915_stream_with_pty(
        move |sender| assert!(queue_0915_r2_data(sender, raw)), "os.read(0, 1)",
        RunOptions { timeout: Duration::from_secs(5), token_exit_grace: Duration::ZERO,
            confirm_exit_grace: Duration::from_millis(200), ..RunOptions::default() }, |_, _| {},
        |_, _, pty| {
            let writer = std::mem::replace(&mut pty.writer, Box::new(std::io::sink()));
            pty.writer = Box::new(UnflushedConfirmation { _writer: writer, buffered: false });
        },
    )).await;
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("capture_failed"));
    assert_eq!(saved, format!("{}b", fake_token()));
    setup_l0d_expect_line(&log, "capture_failed", "confirmation_failed", &[("enter_sent", "false")]);
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix2_child_signal_has_no_exit_code() {
    let ((saved, events), log) = setup_l0d_log(|| run_0915_stream_with_pty(
        |sender| assert!(sender.send(PtyOutput::Eof).is_ok()),
        "import signal\nos.kill(os.getpid(), signal.SIGTERM)", RunOptions::default(), |_, _| {},
        |_, _, pty| assert!(!pty.child.wait().unwrap().success()),
    )).await;
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("cli_error"));
    assert_eq!(saved, format!("{}b", fake_token()));
    let line = setup_l0d_expect_line(&log, "cli_error", "child_signal", &[("exit_code", "none")]);
    assert!(!log.contains("Terminated by"));
    println!("[claude_setup_token] {line}");
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix2_confirming_unwind_keeps_visible_counts() {
    let token = fake_token();
    let raw = format!("Your OAuth token:\r\n{token}\r\n");
    let bytes = raw.len().to_string();
    let (result, log) = setup_l0d_log(|| std::panic::catch_unwind(|| run_0915_r2_stream(
        move |sender| assert!(queue_0915_r2_data(sender, raw)), "os.read(0, 1)",
        RunOptions { timeout: Duration::from_secs(5), ..RunOptions::default() }, |_, event| {
            if event.state == SetupTokenState::Confirming {
                panic!("fixture confirming notification panic");
            }
        },
    ))).await;
    let panic = result.expect_err("the confirmation notification must unwind");
    assert_eq!(panic.downcast_ref::<&str>(), Some(&"fixture confirming notification panic"));
    let line = setup_l0d_expect_line(&log, "save_failed", "save_failed", &[
        ("received_bytes", &bytes), ("visible_rows", "2"), ("value_rows", "1"), ("heading_rows", "1"),
        ("enter_sent", "false"),
    ]);
    assert!(!log.contains(&token[..8]));
    println!("[claude_setup_token] {line}");
}

#[cfg(unix)]
async fn expect_l0d_timeout_screen_rejection(raw: String, reason: &str) {
    let bytes = raw.len().to_string();
    let body = format!("os.write(1, {raw:?}.encode('ascii'))\nos.read(0, 1)");
    let ((saved, events), log) = setup_l0d_log(|| run_0915_r2_stream(
        |_| {}, &body,
        RunOptions { timeout: Duration::from_secs(1), ..RunOptions::default() }, |_, _| {},
    )).await;
    assert_eq!(events.last().unwrap().state, SetupTokenState::Timeout);
    assert_eq!(events.last().unwrap().reason.as_deref(), Some("timeout"));
    assert!(events.iter().all(|event| event.state != SetupTokenState::Confirming));
    let token = fake_token();
    assert_eq!(saved, format!("{token}b"));
    assert!(!log.contains(&token[..8]));
    let line = setup_l0d_expect_line(&log, "timeout", reason, &[
        ("received_bytes", &bytes), ("visible_rows", "3"), ("value_rows", "1"), ("heading_rows", "1"),
        ("control", "none"), ("enter_sent", "false"), ("code_accepted", "false"),
    ]);
    println!("[claude_setup_token] {line}");
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix3_timeout_retains_below_not_blank_or_hint() {
    expect_l0d_timeout_screen_rejection(
        format!("Your OAuth token:\r\n{}\r\nabcdef\r\n", fake_token()),
        "below_not_blank_or_hint",
    ).await;
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix3_timeout_retains_value_line_not_token() {
    expect_l0d_timeout_screen_rejection(
        format!("Your OAuth token:\r\nabcdef\r\n{}\r\n", fake_token()),
        "value_line_not_token",
    ).await;
}

#[cfg(unix)]
#[tokio::test]
async fn setup_token_l0d_fix3_stop_unconfirmed_retains_successful_exit() {
    let (base, _, live) = fixture("exit");
    let registry = SetupTokenRegistry::default();
    let (initial, mut control) = registry.begin(ID).unwrap();
    control.queue_output = Some(Box::new(|sender| { assert!(sender.send(PtyOutput::Eof).is_ok()); }));
    let command = setup_0915_python(base.path(), "sys.exit(0)");
    let (audit, log) = setup_l0d_log(|| run_attempt_with_pty(&registry, initial, control, base.path(), &live, command,
        RunOptions::default(), &MemoryStore::default(), |_| panic!("must not check owner"),
        |path| staging::cleanup_staging_with_credentials(path, &NoCredentials), |_| {},
        |pty| {
            assert!(pty.child.wait().unwrap().success());
            pty.stopped = Some(false);
        }, drop,
    )).await;
    assert!(!audit.child_stopped);
    assert_eq!(registry.current().unwrap().unwrap().reason.as_deref(), Some("capture_failed"));
    let line = setup_l0d_expect_line(&log, "capture_failed", "stop_unconfirmed", &[
        ("previous_reason", "none"), ("exit_code", "0"),
    ]);
    println!("[claude_setup_token] {line}");
}
