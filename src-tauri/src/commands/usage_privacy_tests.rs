//! Native command entry -> real file-backed rows, owner/usage/refresh HTTP
//! failures -> physical OAuth/diagnostic files and OS stderr. No CAPTURE hook.
use super::*;
use crate::usage::logging::ApiUsageCommand;
use std::{fs, path::Path, process::Command};

const MARKERS: &[&str] = &[
    "PRIVATE-upstream-body", "PRIVATE-refresh-body", "PRIVATE-refresh-code",
    "PRIVATE-diagnostic-header", "PRIVATE-profile", "OWNER-A1", "OWNER-B2",
    "PRIVATE-owner@example.invalid", "PRIVATE-label", "PRIVATE-request-id",
    "synthetic-private-access", "synthetic-private-refresh",
];

fn fixture(base: &Path, endpoint: String, tag: &str) -> (UsageApp, String) {
    fs::create_dir_all(base).unwrap();
    let profile_id = format!("claude-PRIVATE-profile-{tag}");
    let token = format!("synthetic-private-access-{tag}");
    let credentials_text = serde_json::json!({"claudeAiOauth": {
        "accessToken": token, "refreshToken": "synthetic-private-refresh",
        "expiresAt": 4102444800000_i64, "refreshTokenExpiresAt": 4102444800000_i64,
    }}).to_string();
    let oauth_account_text = serde_json::json!({"accountUuid":"OWNER-A1",
        "emailAddress":"PRIVATE-owner@example.invalid"}).to_string();
    fs::create_dir_all(base.join("cli_account_snapshots")).unwrap();
    fs::write(base.join("cli_account_snapshots").join(format!("{profile_id}.json")),
        serde_json::json!({"version":1, "provider":"claude", "captured_at":"now",
            "credentials_text":credentials_text, "oauth_account_text":oauth_account_text}).to_string()).unwrap();
    let profile = CliAccountProfile {
        id: profile_id.clone(), provider: CliProvider::Claude, label:"PRIVATE-label".into(),
        email:Some("PRIVATE-owner@example.invalid".into()), identity_key:"OWNER-A1".into(),
        plan:None, org_name:None, captured_at:"now".into(), last_switched_at:None,
        needs_relogin:false, refresh_rejected_at:None, foreign_token_owner:None,
    };
    fs::write(base.join("cli_accounts.json"), serde_json::json!({"version":1,
        "profiles":[profile], "active":{}}).to_string()).unwrap();
    // Explicit file stores only. No Keychain, real CLI paths, or real app data.
    let app = UsageApp::Test(TestUsageApp {
        base: base.to_path_buf(), endpoint,
        claude: ClaudePaths { store: claude::CredentialStore::File,
            credentials: base.join("absent-live-credentials.json"), claude_json: base.join("absent-live-claude.json") },
        codex: CodexPaths { auth: base.join("absent-codex-auth.json") },
        grok: GrokPaths { auth: base.join("absent-grok-auth.json"), lock: base.join("grok-auth.lock") },
    });
    (app, profile_id)
}

fn owner(account: &str) -> String {
    serde_json::json!({"account":{"uuid":account, "email":"PRIVATE-owner@example.invalid"},
        "organization":{"uuid":"org-a"}}).to_string()
}

fn socket_result(command: &str, status: &str) {
    // This is the production socket diagnostic emitter, after command scope
    // exits. Arbitrary request/error values must never reach its physical file.
    crate::socket::log_account_api_result(&crate::socket::SocketRequest {
        id: 7, cmd: command.into(), args: serde_json::json!({"provider":"claude",
            "profile_id":"PRIVATE-profile", "request_id":"PRIVATE-request-id"}),
    }, &crate::socket::SocketResponse { id: 7, error: None,
        result:Some(serde_json::json!({"status":status, "detail":"PRIVATE-upstream-body"})),
    });
}

async fn run_failures(root: &Path, api: bool) {
    for command in ["switch", "reset", "usage"] {
        for failure in ["body", "owner", "refresh"] {
            let tag = format!("{command}-{failure}-{}", if api { "api" } else { "pc" });
            let mut responses = vec![(200, String::new(), owner(if failure == "owner" { "OWNER-B2" } else { "OWNER-A1" }))];
            if failure == "body" { responses.push((500, String::new(), "PRIVATE-upstream-body".into())); }
            if failure == "refresh" {
                responses.push((401, String::new(), "PRIVATE-upstream-body".into()));
                responses.push((400, "cf-ray: PRIVATE-diagnostic-header\r\n".into(),
                    r#"{"error":"PRIVATE-refresh-code","detail":"PRIVATE-refresh-body"}"#.into()));
            }
            let expected_requests = responses.len();
            let (endpoint, received) = reset_tickets::fake_http_sequence_with_headers(responses).await;
            let (app, id) = fixture(&root.join(&tag), endpoint, &tag);
            let state = UsageState::new();
            let policy = if api { Some(match command {
                "switch" => ApiUsageCommand::Switch, "reset" => ApiUsageCommand::ResetTicket,
                _ => ApiUsageCommand::Usage,
            }) } else { None };
            // The actual command implementation installs the invocation policy.
            // These are the three API usage IPCs, including switch/reset followups.
            let report = tokio::time::timeout(std::time::Duration::from_secs(5),
                get_account_usage_command(app, &state, Some(false), policy)).await.unwrap().unwrap();
            assert_eq!(report.accounts.len(), 1);
            assert_eq!(report.accounts[0].profile_id, id);
            assert_eq!(report.accounts[0].error_code.as_deref(), Some(match failure {
                "owner" => ERROR_FOREIGN_TOKEN, "refresh" => ERROR_NEEDS_RELOGIN, _ => ERROR_UPSTREAM,
            }));
            assert_eq!(received.await.unwrap().len(), expected_requests);
            if command != "usage" { socket_result(if command == "switch" { "account.switch" }
                else { "account.use_reset_ticket" }, "failed"); }
        }
    }
    // Also exercise the reset command itself, not just its later inventory IPC.
    let (endpoint, received) = reset_tickets::fake_http_sequence(vec![
        (200, owner("OWNER-A1")), (500, "PRIVATE-upstream-body".into()),
    ]).await;
    let (app, id) = fixture(&root.join("reset-press"), endpoint, "reset-press");
    let state = UsageState::new();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), use_reset_ticket_command(
        app, &state, id, "PRIVATE-request-id".into(), None, api,
        if api { Some(CliProvider::Claude) } else { None },
    )).await.unwrap().unwrap();
    assert_eq!(result.kind, ResetTicketOutcomeKind::Unavailable);
    assert_eq!(result.trace.http_status, Some(500));
    assert_eq!(received.await.unwrap().len(), 2);
    socket_result("account.use_reset_ticket", "not_usable");
}

fn physical_logs(root: &Path) -> String {
    fn collect(dir: &Path, out: &mut String) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() { collect(&path, out); }
            else if path.file_name().unwrap() == "oauth.log" || path.file_name().unwrap() == "diag.log" {
                out.push_str(&fs::read_to_string(path).unwrap());
            }
        }
    }
    let mut out = String::new(); collect(root, &mut out); out
}

#[test]
fn api_entry_failure_paths_reach_physical_logs_only_for_pc() {
    const CHILD: &str = "MYCMUX_ACCOUNT_PRIVACY_TEST_CHILD";
    const ROOT: &str = "MYCMUX_ACCOUNT_PRIVACY_TEST_ROOT";
    if let Ok(mode) = std::env::var(CHILD) {
        let root = std::path::PathBuf::from(std::env::var_os(ROOT).unwrap());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(crate::diag::with_test_dir(root.join("diagnostics"),
            run_failures(&root, mode == "api")));
        return;
    }
    // Child processes provide actual OS stderr capture without changing global
    // file descriptors or the test harness's thread-local output interception.
    let dir = tempfile::tempdir().unwrap();
    for mode in ["api", "pc"] {
        let root = dir.path().join(mode); fs::create_dir_all(&root).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["api_entry_failure_paths_reach_physical_logs_only_for_pc", "--nocapture", "--test-threads=1"])
            .env(CHILD, mode).env(ROOT, &root).output().unwrap();
        assert!(output.status.success(), "{mode} child failed: {}{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        let stderr = String::from_utf8(output.stderr).unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        let logs = physical_logs(&root);
        let diagnostic = fs::read_to_string(root.join("diagnostics/diag.log")).unwrap();
        assert!(diagnostic.contains("cmd=account.switch provider=claude result=failed"));
        assert!(diagnostic.contains("cmd=account.use_reset_ticket provider=claude result=not_usable"));
        assert_eq!(diagnostic.lines().count(), 7);
        for marker in MARKERS {
            assert!(!diagnostic.contains(marker), "private socket diagnostic: {marker}");
            if mode == "api" {
                assert!(!logs.contains(marker), "API physical log leaked {marker}");
                assert!(!stderr.contains(marker), "API physical stderr leaked {marker}");
                assert!(!stdout.contains(marker), "API stdout leaked {marker}");
            }
        }
        if mode == "pc" {
            for marker in ["PRIVATE-upstream-body", "PRIVATE-profile", "OWNER-A1", "OWNER-B2", "PRIVATE-refresh-code"] {
                assert!(logs.contains(marker), "PC physical OAuth detail missing: {marker}");
            }
            for marker in ["PRIVATE-refresh-body", "PRIVATE-refresh-code", "PRIVATE-diagnostic-header"] {
                assert!(stderr.contains(marker), "PC physical stderr detail missing: {marker}");
            }
            assert!(logs.contains("reset_ticket_use"));
        }
    }
}

async fn run_ineligible_api_then_pc(root: &Path) {
    let mut mismatches = Vec::new();
    for reason in ["surface", "cli_version"] {
        let body = serde_json::json!({"cedar_ember": {"eligible":false,
            "ineligible_reason":reason, "grants":[]}}).to_string();
        let (endpoint, received) = reset_tickets::fake_http_sequence(vec![
            (200, owner("OWNER-A1")), (200, body.clone()),
            (200, body.clone()), (200, body),
        ]).await;
        let base = root.join(reason);
        let (app, id) = fixture(&base, endpoint.clone(), reason);
        let state = UsageState::new();
        let report = get_account_usage_command(app, &state, Some(false),
            Some(ApiUsageCommand::Usage)).await.unwrap();
        assert_eq!(report.accounts.len(), 1);
        assert_eq!(report.accounts[0].state, UsageRowState::Ok);
        assert!(!report.accounts[0].reset_tickets.as_ref().unwrap().usable_now);
        assert!(physical_logs(&base).is_empty(), "API emitted a private diagnostic");
        // Same process and state, but force fresh usage requests. A cached
        // PC poll would not reach the once-only diagnostic and hide this defect.
        for _ in 0..2 {
            stale_reset_usage(&state, &id).await;
            let (app, _) = fixture(&base, endpoint.clone(), reason);
            let report = get_account_usage_command(app, &state, Some(false), None).await.unwrap();
            assert_eq!(report.accounts[0].state, UsageRowState::Ok);
            let logs = physical_logs(&base);
            let count = logs.matches("claude_reset_ticket_ineligible").count();
            if count != 1 || !logs.contains(&format!("reason={reason}")) {
                mismatches.push((reason, count));
            }
        }
        assert_eq!(received.await.unwrap().len(), 4);
    }
    assert!(mismatches.is_empty(), "PC diagnostic lost or repeated (reason / count): {mismatches:?}");
}

#[test]
fn api_ineligible_usage_preserves_pc_once_only_diagnostic_in_same_process() {
    const CHILD: &str = "MYCMUX_ACCOUNT_INELIGIBLE_TEST_CHILD";
    const ROOT: &str = "MYCMUX_ACCOUNT_INELIGIBLE_TEST_ROOT";
    if std::env::var_os(CHILD).is_some() {
        let root = std::path::PathBuf::from(std::env::var_os(ROOT).unwrap());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(crate::diag::with_test_dir(root.join("diagnostics"),
            run_ineligible_api_then_pc(&root)));
        return;
    }
    // A fresh process isolates SEEN without any reset hook or manual scope.
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["api_ineligible_usage_preserves_pc_once_only_diagnostic_in_same_process",
            "--nocapture", "--test-threads=1"])
        .env(CHILD, "1").env(ROOT, dir.path()).output().unwrap();
    assert!(output.status.success(), "child failed: {}{}",
        String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let logs = physical_logs(dir.path());
    assert_eq!(logs.matches("claude_reset_ticket_ineligible").count(), 2);
    for reason in ["surface", "cli_version"] {
        assert_eq!(logs.matches(&format!("reason={reason}")).count(), 1);
    }
    for marker in MARKERS {
        assert!(!logs.contains(marker));
        assert!(!String::from_utf8_lossy(&output.stdout).contains(marker));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(marker));
    }
}
