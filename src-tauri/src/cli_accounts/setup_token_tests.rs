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
        screen = '\033[2KYour OAuth token (valid for 1 year):\033[5;1H' + token + '\033[B'
        os.write(1, (screen + '\033[2K' + screen).encode())
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
    for (start, end) in [
        ("\x1b[5;1H", "\x1b[6;1H"), ("\x1b[5;1f", "\x1b[6;1f"),
        ("\x1b[B", "\x1b[B"), ("\x1b[E", "\x1b[E"),
        ("\x1b[5d", "\x1b[4d"), ("\x1b[5d", "\x1b[A"), ("\x1b[5d", "\x1b[F"),
    ] {
        let output = format!("Your OAuth token:{start}{token}{end}");
        let plain = strip_controls(output.as_bytes());
        assert_eq!(extract_token(plain.as_slice()).map(|v| v.as_slice().to_vec()), Some(token.as_bytes().to_vec()));
        let split = format!("OAuth token{start}{}{end}{}\n", &token[..50], &token[50..]);
        assert!(extract_token(strip_controls(split.as_bytes()).as_slice()).is_none());
    }
}

#[test]
fn setup_token_line_edits_cannot_supply_a_candidate() {
    let token = fake_token();
    for edit in ["\x1b[C", "\x1b[D", "\x1b[G", "\x1b[1\x60",
        "\x1b[P", "\x1b[@", "\x1b[X", "\x08", "\r", "\x1b[5;1H", "\x1b[5;1f"] {
        let raw = format!("OAuth token\x1b[5;1H{token}{edit}z\n");
        assert!(extract_token(strip_controls(raw.as_bytes()).as_slice()).is_none(), "{edit:?}");
    }
    let at_bottom = format!("OAuth token\x1b[40d{token}\x1b[B");
    assert!(extract_token(strip_controls(at_bottom.as_bytes()).as_slice()).is_none());
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
    let plain = strip_controls(raw.as_bytes());
    let extracted = extract_token(plain.as_slice()).expect("startup positioning must preserve the heading");
    assert_eq!(extracted.as_slice(), token.as_bytes());
}

#[test]
fn setup_token_accepts_same_row_positioning_before_text() {
    let token = fake_token();
    for (prefix, expected) in [
        ("\x1b[H\x1b[f", Some(token.as_bytes())),
        ("notice\r\n\x1b[2;1H\x1b[2;1f", None),
        ("notice\x1b[2;1H\x1b[2;1f", None),
    ] {
        let raw = format!("{prefix}Your OAuth token:\r\n{token}\r\n");
        let plain = strip_controls(raw.as_bytes());
        let extracted = extract_token(plain.as_slice());
        assert_eq!(extracted.as_ref().map(SecretBytes::as_slice), expected, "{prefix:?}");
    }
}

#[test]
fn setup_token_rejects_same_row_rewrites_of_heading_or_candidate() {
    let token = fake_token();
    let raw = format!("Your \x1b[HOAuth token:\r\n{token}\r\n");
    assert!(extract_token(strip_controls(raw.as_bytes()).as_slice()).is_none());

    let split = token.len() - 1;
    for position in ["\x1b[2;1H", "\x1b[2;1f"] {
        let raw = format!("Your OAuth token:\r\n{}{position}{}\r\n", &token[..split], &token[split..]);
        assert!(extract_token(strip_controls(raw.as_bytes()).as_slice()).is_none(), "{position:?}");
    }
}

#[test]
fn setup_token_rejects_same_row_positioning_after_whitespace() {
    let token = fake_token();
    for whitespace in [' ', '\t'] {
        let raw = format!("{whitespace}\x1b[HYour OAuth token:\r\n{token}\r\n");
        assert!(extract_token(strip_controls(raw.as_bytes()).as_slice()).is_none(), "{whitespace:?}");
    }
}

#[test]
fn setup_token_rejects_same_row_positioning_after_returning_to_written_row() {
    let token = fake_token();
    let mut accepted = Vec::new();
    for position in ["\x1b[2;1H", "\x1b[2;1f", "\x1b[2;5H", "\x1b[2;5f"] {
        let raw = format!("Your OAuth token:\r\ntag:XX\r\n\x1b[A{position}{token}\r\n");
        if extract_token(strip_controls(raw.as_bytes()).as_slice()).is_some() {
            accepted.push(position);
        }
    }
    assert!(accepted.is_empty(), "positioning on a written row supplied a candidate: {accepted:?}");
}

#[test]
fn setup_token_rejects_same_row_positioning_after_moving_to_unwritten_row() {
    let token = fake_token();
    let mut accepted = Vec::new();
    for command in ['H', 'f'] {
        let raw = format!("notice\x1b[3d\x1b[A\x1b[2;1{command}Your OAuth token:\r\n{token}\r\n");
        if extract_token(strip_controls(raw.as_bytes()).as_slice()).is_some() {
            accepted.push(command);
        }
    }
    assert!(accepted.is_empty(), "positioning after text supplied a candidate: {accepted:?}");
}

#[test]
fn setup_token_rejects_same_row_positioning_after_whitespace_or_screen_clear() {
    let token = fake_token();
    let mut accepted = Vec::new();
    for (prefix, row) in [
        (" ", ""), ("\t", ""),
        (" \r\n", "2;1"), ("\t\r\n", "2;1"),
        ("notice\x1b[2J", ""), ("notice\r\n\x1b[2J", "2;1"),
    ] {
        for command in ['H', 'f'] {
            let raw = format!("{prefix}\x1b[{row}{command}Your OAuth token:\r\n{token}\r\n");
            if extract_token(strip_controls(raw.as_bytes()).as_slice()).is_some() {
                accepted.push((prefix, row, command));
            }
        }
    }
    assert!(accepted.is_empty(), "positioning after text supplied a candidate: {accepted:?}");
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
            if extract_token(strip_controls(raw.as_bytes()).as_slice()).is_some() {
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
    let mut accepted = Vec::new();
    for (case, drawing) in [
        ("line erase", format!("{first_half}\x1b[2K{second_half}\r\n")),
        (
            "overwritten continuation",
            format!("{token}\r\nCD\x1b[2K\x1b[GPress Enter to continue.\r\n"),
        ),
        (
            "later candidate rewrite",
            format!("{token}\r\nPress Enter to continue.\x1b[2;2HZ\r\n"),
        ),
    ] {
        for command in ['H', 'f'] {
            let raw = format!("Your OAuth token:\r\n\x1b[2;1{command}{drawing}");
            if extract_token(strip_controls(raw.as_bytes()).as_slice()).is_some() {
                accepted.push((case, command));
            }
        }
    }
    assert!(accepted.is_empty(), "positioning before an edited row supplied a candidate: {accepted:?}");
}

#[test]
fn setup_token_rejects_non_first_column_positioning_on_empty_row() {
    let token = fake_token();
    let mut accepted = Vec::new();
    for position in ["\x1b[2;2H", "\x1b[2;2f", "\x1b[2;511H", "\x1b[2;511f"] {
        let raw = format!("Your OAuth token:\r\n{position}{token}\x1b[3;1H!\r\n");
        if extract_token(strip_controls(raw.as_bytes()).as_slice()).is_some() {
            accepted.push(position);
        }
    }
    assert!(accepted.is_empty(), "non-first-column positioning supplied a candidate: {accepted:?}");
}

#[test]
fn setup_token_accepts_first_column_positioning_on_empty_first_row() {
    let token = fake_token();
    for position in ["\x1b[H", "\x1b[1;1H", "\x1b[;H"] {
        let raw = format!("{position}Your OAuth token:\r\n{token}\r\n");
        let plain = strip_controls(raw.as_bytes());
        let extracted = extract_token(plain.as_slice()).expect("first-column positioning must preserve the heading");
        assert_eq!(extracted.as_slice(), token.as_bytes());
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
        assert_eq!(event.state, SetupTokenState::Failed, "{mode}");
        assert_eq!(event.reason.as_deref(), Some("capture_failed"));
        assert_eq!(store.read(ID).unwrap().as_deref(), Some(fake_token().as_str()));
    }
}

#[cfg(unix)]
#[test]
fn setup_token_cursor_visibility_does_not_complete_a_candidate_but_conpty_redraw_does() {
    for (mode, expected) in [
        ("cursor_visibility_eof", SetupTokenState::Failed),
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
        let saved = if expected == SetupTokenState::Saved { fixture_token(base.path()) } else { fake_token() };
        assert!(store.read(ID).unwrap().as_deref() == Some(saved.as_str()), "{mode}");
    }
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
        let expected_value = if saved { fixture_token(base.path()) } else { previous };
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
        ("overwrite_last_byte", Some("capture_failed")),
        ("erase_display_eof", Some("capture_failed")),
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
    let messages: Vec<_> = logs_text.lines().filter_map(|line|
        line.split_once("[claude_setup_token] ").map(|(_, message)| message)).collect();
    assert_eq!(messages, ["stop_unconfirmed previous_reason=cancelled"]);
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
