use super::*;
use super::{claude::ClaudePaths, codex::CodexPaths, json_splice::*};
use std::fs;
use tempfile::tempdir;

const CLAUDE_JSON: &str = include_str!("fixtures/claude_json_sample.json");
const CREDS: &str = include_str!("fixtures/claude_credentials_sample.json");
const CODEX: &str = include_str!("fixtures/codex_auth_sample.json");
const GROK: &str = include_str!("fixtures/grok_auth_sample.json");

fn fixture_owner(token: &str) -> Option<TokenOwner> {
    Some(TokenOwner { account_uuid: match token {
        "synthetic-access-b" => "claude-account-b",
        "synthetic-access-other" => "other",
        _ => "claude-account-a",
    }.into(), email: None })
}

#[test]
fn splice_replaces_only_target_member() {
    let (s, e) = find_top_level_member(CLAUDE_JSON, "oauthAccount")
        .unwrap()
        .unwrap();
    let out =
        replace_top_level_member(CLAUDE_JSON, "oauthAccount", r#"{"accountUuid":"b"}"#).unwrap();
    assert_eq!(&out[..s], &CLAUDE_JSON[..s]);
    assert_eq!(
        &out[out.len() - (CLAUDE_JSON.len() - e)..],
        &CLAUDE_JSON[e..]
    );
}
#[test]
fn splice_inserts_when_key_absent() {
    assert_eq!(
        replace_top_level_member("{}", "x", "1").unwrap(),
        r#"{"x":1}"#
    );
    assert_eq!(
        replace_top_level_member(r#"{"a":1}"#, "x", "true").unwrap(),
        r#"{"x":true,"a":1}"#
    );
}
#[test]
fn splice_ignores_nested_key_of_same_name() {
    let v = extract_top_level_member(CLAUDE_JSON, "oauthAccount")
        .unwrap()
        .unwrap();
    assert!(v.contains("claude-account-a"));
}
#[test]
fn splice_rejects_invalid_json() {
    assert!(replace_top_level_member("{", "x", "1").is_err());
    assert!(replace_top_level_member("{}", "x", "{").is_err());
}
#[test]
fn splice_handles_escaped_quotes_and_unicode() {
    let t = r#"{"name":"\"日本語\"","oauthAccount":{"x":1}}"#;
    assert!(replace_top_level_member(t, "oauthAccount", r#"{"x":2}"#)
        .unwrap()
        .contains("日本語"));
}
#[test]
fn codex_identity_from_id_token() {
    let d = tempdir().unwrap();
    let p = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&p.auth, CODEX).unwrap();
    let x = codex::read_live_identity(&p);
    assert_eq!(x.email.as_deref(), Some("codex@example.test"));
    assert_eq!(x.identity_key.as_deref(), Some("codex-account-a"));
    assert_eq!(x.plan.as_deref(), Some("pro"));
}
#[test]
fn codex_identity_survives_expired_id_token() {
    let d = tempdir().unwrap();
    let p = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&p.auth, CODEX).unwrap();
    assert!(codex::read_live_identity(&p).present);
}
#[test]
fn codex_identity_rejects_malformed_jwt() {
    for s in ["one", "a.!.c", "a.e30.c.d"] {
        assert!(codex::decode_id_token_claims(s).is_err());
    }
}
#[test]
fn grok_identity_reads_fixture_and_tier() {
    let d = tempdir().unwrap();
    let paths = grok::GrokPaths { auth: d.path().join("auth.json"), lock: d.path().join("auth.json.lock") };
    fs::write(&paths.auth, GROK).unwrap();
    let live = grok::read_live_identity(&paths);
    assert_eq!(live.email.as_deref(), Some("grok@example.test"));
    assert_eq!(live.identity_key.as_deref(), Some("grok-user-a"));
    assert_eq!(live.plan.as_deref(), Some("supergrok"));
}
#[test]
fn claude_identity_and_relogin() {
    let d = tempdir().unwrap();
    let p = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("c.json"),
        claude_json: d.path().join("x.json"),
    };
    fs::write(&p.credentials, CREDS).unwrap();
    fs::write(&p.claude_json, CLAUDE_JSON).unwrap();
    assert_eq!(
        claude::read_live_identity(&p).email.as_deref(),
        Some("a@example.test")
    );
    assert!(!claude::needs_relogin(CREDS));
    assert!(claude::needs_relogin(
        r#"{"claudeAiOauth":{"refreshTokenExpiresAt":1}}"#
    ));
    assert!(claude::needs_relogin("not-json"));
    assert!(claude::needs_relogin(r#"{"claudeAiOauth":{}}"#));
}
#[test]
fn registry_round_trip_and_defaults() {
    let d = tempdir().unwrap();
    let mut f = registry::CliAccountsFile::default();
    let p = CliAccountProfile {
        id: "claude-12345678".into(),
        provider: CliProvider::Claude,
        label: "a".into(),
        email: None,
        identity_key: "a".into(),
        plan: None,
        org_name: None,
        captured_at: "x".into(),
        last_switched_at: None,
        needs_relogin: false,
        refresh_rejected_at: None,
        foreign_token_owner: None,
    };
    registry::upsert_by_identity_key(&mut f, p);
    registry::save(d.path(), &f).unwrap();
    assert_eq!(registry::load(d.path()).unwrap().profiles.len(), 1);
    fs::write(d.path().join("cli_accounts.json"), "{}").unwrap();
    assert!(registry::load(d.path()).unwrap().profiles.is_empty());
}

#[test]
fn registry_loads_legacy_profile_without_refresh_rejection() {
    let d = tempdir().unwrap();
    fs::write(
        d.path().join("cli_accounts.json"),
        r#"{
  "version": 1,
  "profiles": [{
    "id": "claude-legacy",
    "provider": "claude",
    "label": "legacy",
    "identity_key": "legacy-account",
    "captured_at": "2026-08-08T00:00:00Z",
    "needs_relogin": false
  }],
  "active": {}
}"#,
    )
    .unwrap();

    let file = registry::load(d.path()).unwrap();
    assert!(file.profiles[0].refresh_rejected_at.is_none());
    assert!(file.profiles[0].foreign_token_owner.is_none());
    registry::save(d.path(), &file).unwrap();
    assert!(!fs::read_to_string(d.path().join("cli_accounts.json"))
        .unwrap()
        .contains("refresh_rejected_at"));
}
#[test]
fn backup_rotation_keeps_ten_newest() {
    let d = tempdir().unwrap();
    let live = d.path().join("live.json");
    fs::write(&live, "x").unwrap();
    for n in 0..11 {
        let p = d
            .path()
            .join("cli_account_backups")
            .join(format!("20260101T000000.{n:03}Z-00000000"));
        fs::create_dir_all(p).unwrap();
    }
    let unrelated = d.path().join("cli_account_backups").join("keep-user-data");
    fs::create_dir_all(&unrelated).unwrap();
    snapshot::backup_live_files(d.path(), &[&live]).unwrap();
    assert_eq!(
        fs::read_dir(d.path().join("cli_account_backups"))
            .unwrap()
            .count(),
        11
    );
    assert!(unrelated.is_dir());
}
#[test]
fn snapshot_round_trip_is_byte_identical() {
    let d = tempdir().unwrap();
    let s = snapshot::StoredSnapshot::Codex(snapshot::CodexSnapshot {
        version: 1,
        provider: CliProvider::Codex,
        captured_at: "x".into(),
        auth_text: CODEX.into(),
    });
    snapshot::save(d.path(), "codex-12345678", &s).unwrap();
    match snapshot::load(d.path(), "codex-12345678").unwrap() {
        snapshot::StoredSnapshot::Codex(x) => assert_eq!(x.auth_text, CODEX),
        _ => panic!(),
    }
}

#[test]
fn grok_snapshot_round_trip_is_distinct_from_codex() {
    let d = tempdir().unwrap();
    let stored = snapshot::StoredSnapshot::Grok(snapshot::GrokSnapshot {
        version: 1,
        provider: CliProvider::Grok,
        captured_at: "x".into(),
        grok_auth_text: GROK.into(),
    });
    let wire = serde_json::to_string(&stored).unwrap();
    assert!(wire.contains("grok_auth_text"));
    assert!(!wire.contains("\"auth_text\""));
    let decoded: snapshot::StoredSnapshot = serde_json::from_str(&wire).unwrap();
    match decoded {
        snapshot::StoredSnapshot::Grok(value) => assert_eq!(value.grok_auth_text, GROK),
        _ => panic!("grok snapshot must not deserialize as codex"),
    }
    snapshot::save(d.path(), "grok-12345678", &stored).unwrap();
    assert!(matches!(snapshot::load(d.path(), "grok-12345678").unwrap(), snapshot::StoredSnapshot::Grok(_)));
}

#[test]
fn legacy_registry_without_grok_pointer_loads() {
    let d = tempdir().unwrap();
    fs::write(d.path().join("cli_accounts.json"), r#"{"active":{"claude":"claude-a","codex":null}}"#).unwrap();
    let file = registry::load(d.path()).unwrap();
    assert_eq!(file.active.claude.as_deref(), Some("claude-a"));
    assert!(file.active.grok.is_none());
}

#[test]
fn snapshot_paths_reject_traversal_and_non_owned_ids() {
    let d = tempdir().unwrap();
    let stored = snapshot::StoredSnapshot::Codex(snapshot::CodexSnapshot {
        version: 1,
        provider: CliProvider::Codex,
        captured_at: "x".into(),
        auth_text: CODEX.into(),
    });
    for id in [
        "../codex-outside",
        "..\\codex-outside",
        "C:\\codex-outside",
        "foreign-id",
    ] {
        assert_eq!(
            snapshot::save(d.path(), id, &stored),
            Err(ERR_SNAPSHOT_INVALID.to_string())
        );
        assert!(snapshot::load(d.path(), id).is_err());
        assert!(snapshot::remove(d.path(), id).is_err());
    }
}

#[test]
fn orphan_metadata_rejects_provider_or_prefix_mismatch() {
    let stored = snapshot::StoredSnapshot::Codex(snapshot::CodexSnapshot {
        version: 1,
        provider: CliProvider::Claude,
        captured_at: "x".into(),
        auth_text: CODEX.into(),
    });
    assert!(snapshot::metadata_for_orphan("unregistered-codex-x", &stored).is_err());

    let stored = snapshot::StoredSnapshot::Codex(snapshot::CodexSnapshot {
        version: 1,
        provider: CliProvider::Codex,
        captured_at: "x".into(),
        auth_text: CODEX.into(),
    });
    assert!(snapshot::metadata_for_orphan("unregistered-claude-x", &stored).is_err());
}
#[test]
fn switch_flow_end_to_end_in_tempdir() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let first = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    let changed = CLAUDE_JSON
        .replace("claude-account-a", "claude-account-b")
        .replace("a@example.test", "b@example.test");
    fs::write(&cp.claude_json, &changed).unwrap();
    fs::write(&cp.credentials, CREDS.replace("synthetic-access", "synthetic-access-b")).unwrap();
    let second = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    fs::write(&cp.credentials, CREDS).unwrap();
    switch_account(d.path(), &cp, &xp, CliProvider::Claude, &second.id, &fixture_owner).unwrap();
    assert!(fs::read_to_string(&cp.claude_json)
        .unwrap()
        .contains("claude-account-b"));
    assert!(snapshot::load(d.path(), &first.id).is_ok());
    assert!(d.path().join("cli_account_backups").is_dir());
}

#[test]
fn switch_persists_live_rejection_clear_before_target_validation() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let first = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    let changed = CLAUDE_JSON
        .replace("claude-account-a", "claude-account-b")
        .replace("a@example.test", "b@example.test");
    fs::write(&cp.claude_json, &changed).unwrap();
    fs::write(&cp.credentials, CREDS.replace("synthetic-access", "synthetic-access-b")).unwrap();
    let second = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    record_refresh_rejection(d.path(), &first.id, "2026-08-09T00:00:00Z".into()).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(
        snapshot::snapshot_dir(d.path()).join(format!("{}.json", second.id)),
        "{}",
    )
    .unwrap();

    let result = switch_account(d.path(), &cp, &xp, CliProvider::Claude, &second.id, &fixture_owner);
    assert!(matches!(
        result,
        Err(ref error) if error == ERR_SNAPSHOT_UNAVAILABLE
    ));
    let saved = registry::load(d.path()).unwrap();
    assert!(saved
        .profiles
        .iter()
        .find(|profile| profile.id == first.id)
        .unwrap()
        .refresh_rejected_at
        .is_none());
}

#[test]
fn update_snapshot_tokens_rejects_stale_refresh_token() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let profile = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    let path = snapshot::snapshot_dir(d.path()).join(format!("{}.json", profile.id));
    let before = fs::read(&path).unwrap();
    assert_eq!(
        update_snapshot_tokens(
            d.path(),
            &profile.id,
            CliProvider::Claude,
            "synthetic-stale-refresh",
            |text| Ok(text.replace("synthetic-access", "synthetic-next-access")),
        ),
        Ok(SnapshotUpdate::Conflict)
    );
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn refreshed_snapshot_still_restores_byte_exact() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let first = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    let changed = CLAUDE_JSON
        .replace("claude-account-a", "claude-account-b")
        .replace("a@example.test", "b@example.test");
    fs::write(&cp.claude_json, &changed).unwrap();
    fs::write(&cp.credentials, CREDS.replace("synthetic-access", "synthetic-access-b")).unwrap();
    let second = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let expected = CREDS
        .replace("synthetic-access", "synthetic-refreshed-access")
        .replace("synthetic-refresh", "synthetic-refreshed-refresh");
    assert_eq!(
        update_snapshot_tokens(
            d.path(),
            &second.id,
            CliProvider::Claude,
            "synthetic-refresh",
            |_| Ok(expected.clone()),
        ),
        Ok(SnapshotUpdate::Applied)
    );
    // The chained replace above also rewrites the "synthetic-refresh" prefix
    // inside the new access token, so name the owner of the access token the
    // refreshed credentials actually carry instead of guessing its spelling.
    let refreshed_access = token_owner::claude_access_token(&expected).unwrap();
    let owner_of_refreshed = |token: &str| {
        if token == refreshed_access {
            Some(TokenOwner { account_uuid: "claude-account-b".into(), email: None })
        } else {
            fixture_owner(token)
        }
    };
    switch_account(d.path(), &cp, &xp, CliProvider::Claude, &second.id, &owner_of_refreshed).unwrap();
    assert_eq!(fs::read(&cp.credentials).unwrap(), expected.as_bytes());
    assert_eq!(
        claude::read_live_identity(&cp).identity_key.as_deref(),
        Some(second.identity_key.as_str())
    );
    assert!(snapshot::load(d.path(), &first.id).is_ok());
}
#[test]
fn switch_writes_orphan_snapshot_for_unregistered_live_login() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let target = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    let changed = CLAUDE_JSON.replace("claude-account-a", "other");
    fs::write(&cp.claude_json, changed).unwrap();
    fs::write(&cp.credentials, CREDS.replace("synthetic-access", "synthetic-access-other")).unwrap();
    switch_account(d.path(), &cp, &xp, CliProvider::Claude, &target.id, &fixture_owner).unwrap();
    assert!(fs::read_dir(d.path().join("cli_account_snapshots"))
        .unwrap()
        .flatten()
        .any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("unregistered-claude-")));
}

fn test_profile(id: &str) -> CliAccountProfile {
    CliAccountProfile {
        id: id.into(),
        provider: CliProvider::Claude,
        label: "original".into(),
        email: Some("person@example.test".into()),
        identity_key: "identity".into(),
        plan: Some("pro".into()),
        org_name: Some("org".into()),
        captured_at: "captured".into(),
        last_switched_at: Some("switched".into()),
        needs_relogin: true,
        refresh_rejected_at: None,
        foreign_token_owner: None,
    }
}
#[test]
fn remove_resolved_deletes_snapshot_and_clears_active_pointer() {
    let d = tempdir().unwrap();
    let profile = test_profile("claude-12345678");
    let mut file = registry::CliAccountsFile::default();
    registry::upsert_by_identity_key(&mut file, profile.clone());
    registry::set_active(&mut file, CliProvider::Claude, Some(profile.id.clone()));
    registry::save(d.path(), &file).unwrap();
    let stored = snapshot::StoredSnapshot::Claude(snapshot::ClaudeSnapshot {
        version: 1,
        provider: CliProvider::Claude,
        captured_at: "x".into(),
        credentials_text: CREDS.into(),
        oauth_account_text: CLAUDE_JSON.into(),
    });
    snapshot::save(d.path(), &profile.id, &stored).unwrap();
    remove_resolved(d.path(), &profile.id).unwrap();
    let saved = registry::load(d.path()).unwrap();
    assert!(saved.profiles.is_empty());
    assert!(saved.active.claude.is_none());
    assert!(!snapshot::snapshot_dir(d.path())
        .join(format!("{}.json", profile.id))
        .exists());
}
/// Registry + snapshot for one account, with no live login files on disk.
fn rescue_fixture(dir: &Path, id: &str, identity: &str) -> CliAccountProfile {
    let mut profile = test_profile(id);
    profile.identity_key = identity.into();
    let mut file = registry::CliAccountsFile::default();
    registry::upsert_by_identity_key(&mut file, profile.clone());
    registry::set_active(&mut file, CliProvider::Claude, Some(profile.id.clone()));
    registry::save(dir, &file).unwrap();
    let stored = snapshot::StoredSnapshot::Claude(snapshot::ClaudeSnapshot {
        version: 1,
        provider: CliProvider::Claude,
        captured_at: "x".into(),
        credentials_text: CREDS.into(),
        oauth_account_text: r#"{"accountUuid":"claude-account-a","emailAddress":"a@example.test","organizationName":"Example Org"}"#.into(),
    });
    snapshot::save(dir, &profile.id, &stored).unwrap();
    profile
}

fn archived_snapshot(dir: &Path, id: &str) -> std::path::PathBuf {
    let profile = rescue_fixture(dir, id, "claude-account-a");
    let live = snapshot::snapshot_dir(dir).join(format!("{}.json", profile.id));
    let archive =
        snapshot::snapshot_dir(dir).join(format!("{}.rejected-20260810.json", profile.id));
    fs::rename(live, &archive).unwrap();
    let mut file = registry::load(dir).unwrap();
    assert!(registry::remove_profile(&mut file, &profile.id));
    registry::save(dir, &file).unwrap();
    archive
}

#[test]
fn list_rejected_keeps_only_the_newest_archive_per_id() {
    let d = tempdir().unwrap();
    let old = archived_snapshot(d.path(), "claude-12345678");
    let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&old)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old_time))
        .unwrap();
    let profile = rescue_fixture(d.path(), "claude-12345678", "claude-account-a");
    let live = snapshot::snapshot_dir(d.path()).join(format!("{}.json", profile.id));
    let latest =
        snapshot::snapshot_dir(d.path()).join(format!("{}.rejected-20260810-2.json", profile.id));
    fs::rename(live, &latest).unwrap();
    let mut file = registry::load(d.path()).unwrap();
    assert!(registry::remove_profile(&mut file, &profile.id));
    registry::save(d.path(), &file).unwrap();

    assert_eq!(
        snapshot::list_rejected(d.path()).unwrap(),
        vec![(profile.id, latest)]
    );
}

#[test]
fn rescue_restores_a_rejected_snapshot() {
    let d = tempdir().unwrap();
    let archive = archived_snapshot(d.path(), "claude-12345678");
    assert_eq!(
        snapshot::list_rejected(d.path()).unwrap(),
        vec![("claude-12345678".into(), archive.clone())]
    );
    let restored = rescue_rejected_snapshots(d.path()).unwrap();

    assert_eq!(restored, vec!["claude-12345678"]);
    let saved = registry::load(d.path()).unwrap();
    assert_eq!(saved.profiles.len(), 1);
    assert!(saved.profiles[0].needs_relogin);
    assert!(saved.profiles[0].refresh_rejected_at.is_some());
    assert!(snapshot::snapshot_dir(d.path())
        .join("claude-12345678.json")
        .is_file());
    assert!(!archive.exists());
}

#[test]
fn rescue_skips_when_a_live_snapshot_exists() {
    let d = tempdir().unwrap();
    let archive = archived_snapshot(d.path(), "claude-12345678");
    let stored: snapshot::StoredSnapshot =
        serde_json::from_str(&fs::read_to_string(&archive).unwrap()).unwrap();
    snapshot::save(d.path(), "claude-12345678", &stored).unwrap();

    assert!(rescue_rejected_snapshots(d.path()).unwrap().is_empty());
    assert!(registry::load(d.path()).unwrap().profiles.is_empty());
    assert!(archive.is_file());
}

#[test]
fn rescue_skips_a_duplicate_identity() {
    let d = tempdir().unwrap();
    let archive = archived_snapshot(d.path(), "claude-12345678");
    let mut duplicate = test_profile("claude-87654321");
    duplicate.identity_key = "claude-account-a".into();
    let mut file = registry::CliAccountsFile::default();
    registry::upsert_by_identity_key(&mut file, duplicate);
    registry::save(d.path(), &file).unwrap();

    assert!(rescue_rejected_snapshots(d.path()).unwrap().is_empty());
    assert_eq!(registry::load(d.path()).unwrap().profiles.len(), 1);
    assert!(archive.is_file());
}

#[test]
fn rename_resolved_changes_only_label() {
    let d = tempdir().unwrap();
    let mut profile = test_profile("claude-12345678");
    profile.refresh_rejected_at = Some("2026-08-09T00:00:00Z".into());
    let mut file = registry::CliAccountsFile::default();
    registry::upsert_by_identity_key(&mut file, profile.clone());
    registry::save(d.path(), &file).unwrap();
    let renamed = rename_resolved(d.path(), &profile.id, "renamed".into()).unwrap();
    assert_eq!(renamed.label, "renamed");
    assert_eq!(renamed.id, profile.id);
    assert_eq!(renamed.email, profile.email);
    assert_eq!(renamed.identity_key, profile.identity_key);
    assert_eq!(renamed.plan, profile.plan);
    assert_eq!(renamed.org_name, profile.org_name);
    assert_eq!(renamed.captured_at, profile.captured_at);
    assert_eq!(renamed.last_switched_at, profile.last_switched_at);
    assert_eq!(renamed.needs_relogin, profile.needs_relogin);
    assert_eq!(renamed.refresh_rejected_at, profile.refresh_rejected_at);
}

#[test]
fn list_recomputes_relogin_without_rewriting_registry() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let profile = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    let stored = snapshot::StoredSnapshot::Claude(snapshot::ClaudeSnapshot {
        version: 1,
        provider: CliProvider::Claude,
        captured_at: "x".into(),
        credentials_text: r#"{"claudeAiOauth":{"refreshTokenExpiresAt":1}}"#.into(),
        oauth_account_text: r#"{"accountUuid":"claude-account-a"}"#.into(),
    });
    snapshot::save(d.path(), &profile.id, &stored).unwrap();
    let registry_before = fs::read_to_string(d.path().join("cli_accounts.json")).unwrap();
    let result = list(d.path(), &cp, &xp).unwrap();
    assert!(result.profiles[0].needs_relogin);
    assert_eq!(
        fs::read_to_string(d.path().join("cli_accounts.json")).unwrap(),
        registry_before
    );
}

#[test]
fn refresh_rejection_forces_relogin_with_future_expiry() {
    let d = tempdir().unwrap();
    let mut profile = test_profile("claude-12345678");
    profile.needs_relogin = false;
    profile.refresh_rejected_at = Some("2026-08-09T00:00:00Z".into());
    let stored = snapshot::StoredSnapshot::Claude(snapshot::ClaudeSnapshot {
        version: 1,
        provider: CliProvider::Claude,
        captured_at: "x".into(),
        credentials_text: CREDS.into(),
        oauth_account_text: CLAUDE_JSON.into(),
    });
    snapshot::save(d.path(), &profile.id, &stored).unwrap();

    let profiles = refreshed_profiles(d.path(), &[profile]);
    assert!(profiles[0].needs_relogin);

    let mut codex = test_profile("codex-12345678");
    codex.provider = CliProvider::Codex;
    codex.needs_relogin = false;
    codex.refresh_rejected_at = Some("2026-08-09T00:00:00Z".into());
    assert!(refreshed_profiles(d.path(), &[codex])[0].needs_relogin);
}

#[test]
fn refresh_rejection_marks_but_keeps_profile() {
    let d = tempdir().unwrap();
    let profile = rescue_fixture(d.path(), "claude-12345678", "claude-account-a");
    record_refresh_rejection(d.path(), &profile.id, "2026-08-10T00:00:00Z".into()).unwrap();

    assert_eq!(registry::load(d.path()).unwrap().profiles.len(), 1);
    let cp = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("live-credentials.json"),
        claude_json: d.path().join("live-claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("live-auth.json"),
    };
    assert!(list(d.path(), &cp, &xp).unwrap().profiles[0].needs_relogin);
    assert!(snapshot::snapshot_dir(d.path())
        .join("claude-12345678.json")
        .is_file());
    assert!(snapshot::list_rejected(d.path()).unwrap().is_empty());
}

#[test]
fn no_refresh_rejection_uses_stored_expiry_only() {
    let d = tempdir().unwrap();
    let mut profile = test_profile("claude-12345678");
    profile.refresh_rejected_at = None;
    let future = snapshot::StoredSnapshot::Claude(snapshot::ClaudeSnapshot {
        version: 1,
        provider: CliProvider::Claude,
        captured_at: "x".into(),
        credentials_text: CREDS.into(),
        oauth_account_text: CLAUDE_JSON.into(),
    });
    snapshot::save(d.path(), &profile.id, &future).unwrap();
    assert!(!refreshed_profiles(d.path(), &[profile.clone()])[0].needs_relogin);

    let expired = snapshot::StoredSnapshot::Claude(snapshot::ClaudeSnapshot {
        credentials_text: r#"{"claudeAiOauth":{"refreshTokenExpiresAt":1}}"#.into(),
        ..match future {
            snapshot::StoredSnapshot::Claude(stored) => stored,
            _ => unreachable!(),
        }
    });
    snapshot::save(d.path(), &profile.id, &expired).unwrap();
    assert!(refreshed_profiles(d.path(), &[profile])[0].needs_relogin);
}

#[test]
fn recapture_clears_refresh_rejection() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let first = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    record_refresh_rejection(d.path(), &first.id, "2026-08-09T00:00:00Z".into()).unwrap();
    assert_eq!(
        registry::load(d.path()).unwrap().profiles[0]
            .refresh_rejected_at
            .as_deref(),
        Some("2026-08-09T00:00:00Z")
    );

    let recaptured = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None, &fixture_owner, UnverifiedPolicy::Refuse).unwrap();
    assert_eq!(recaptured.id, first.id);
    assert!(recaptured.refresh_rejected_at.is_none());
    let saved = registry::load(d.path()).unwrap();
    assert_eq!(saved.profiles.len(), 1);
    assert!(saved.profiles[0].refresh_rejected_at.is_none());
}

#[test]
fn list_exposes_intended_active_pointer() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        store: claude::CredentialStore::File,
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    let mut file = registry::CliAccountsFile::default();
    registry::set_active(
        &mut file,
        CliProvider::Claude,
        Some("claude-intended".into()),
    );
    registry::save(d.path(), &file).unwrap();
    let result = list(d.path(), &cp, &xp).unwrap();
    assert_eq!(result.active.claude.as_deref(), Some("claude-intended"));
}

#[test]
fn orphan_can_be_registered_without_moving_or_exposing_secret_text() {
    let d = tempdir().unwrap();
    let stored = snapshot::StoredSnapshot::Claude(snapshot::ClaudeSnapshot {
        version: 1,
        provider: CliProvider::Claude,
        captured_at: "2026-08-08T00:00:00Z".into(),
        credentials_text: CREDS.into(),
        oauth_account_text:
            r#"{"accountUuid":"orphan-account","emailAddress":"orphan@example.test"}"#.into(),
    });
    let path = snapshot::save_orphan(d.path(), CliProvider::Claude, &stored).unwrap();
    let id = path.file_stem().unwrap().to_string_lossy().to_string();
    let listed = snapshot::list_orphans(d.path(), &[]).unwrap();
    assert_eq!(listed.len(), 1);
    let wire = serde_json::to_string(&listed[0]).unwrap();
    assert!(!wire.contains("accessToken"));
    assert!(!wire.contains("refreshToken"));

    let registered = resolve_orphan_inner(
        d.path(),
        &id,
        CliOrphanAction::Register,
        Some("saved".into()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(registered.id, id);
    assert_eq!(registered.label, "saved");
    assert!(path.is_file());
    assert!(snapshot::list_orphans(d.path(), &[registered])
        .unwrap()
        .is_empty());
}

#[test]
fn orphan_discard_rejects_unsafe_ids_and_removes_only_the_target() {
    let d = tempdir().unwrap();
    assert_eq!(
        snapshot::discard_orphan(d.path(), "..\\cli_accounts"),
        Err(ERR_ORPHAN_INVALID.to_string())
    );
    let stored = snapshot::StoredSnapshot::Codex(snapshot::CodexSnapshot {
        version: 1,
        provider: CliProvider::Codex,
        captured_at: "x".into(),
        auth_text: CODEX.into(),
    });
    let path = snapshot::save_orphan(d.path(), CliProvider::Codex, &stored).unwrap();
    let id = path.file_stem().unwrap().to_string_lossy().to_string();
    resolve_orphan_inner(d.path(), &id, CliOrphanAction::Discard, None).unwrap();
    assert!(!path.exists());
}

fn synthetic_owner(identity: &str) -> TokenOwner {
    TokenOwner { account_uuid: identity.into(), email: Some(format!("{identity}@example.test")) }
}

fn owner_lookup(token: &str) -> Option<TokenOwner> {
    match token {
        "p-access" => Some(synthetic_owner("P")),
        "x-access" | "x-live" => Some(synthetic_owner("X")),
        _ => None,
    }
}

fn owner_credentials(token: &str) -> String {
    CREDS.replace("synthetic-access", token)
        .replace("synthetic-refresh", &format!("{token}-refresh"))
}

struct OwnerCase {
    dir: tempfile::TempDir,
    cp: ClaudePaths,
    xp: CodexPaths,
    p: CliAccountProfile,
    x: CliAccountProfile,
}

impl OwnerCase {
    fn new() -> Self {
        let dir = tempdir().unwrap();
        let cp = ClaudePaths { store: claude::CredentialStore::File,
            credentials: dir.path().join("live-credentials.json"), claude_json: dir.path().join("live-name.json") };
        let xp = CodexPaths { auth: dir.path().join("codex-auth.json") };
        fs::write(&cp.claude_json, CLAUDE_JSON.replace("claude-account-a", "P")).unwrap();
        fs::write(&cp.credentials, owner_credentials("p-access")).unwrap();
        let p = capture_account(dir.path(), &cp, &xp, CliProvider::Claude, None, &owner_lookup, UnverifiedPolicy::Refuse).unwrap();
        fs::write(&cp.claude_json, CLAUDE_JSON.replace("claude-account-a", "X")).unwrap();
        fs::write(&cp.credentials, owner_credentials("x-access")).unwrap();
        let x = capture_account(dir.path(), &cp, &xp, CliProvider::Claude, None, &owner_lookup, UnverifiedPolicy::Refuse).unwrap();
        let case = Self { dir, cp, xp, p, x };
        case.live("P", "x-live");
        case
    }

    fn live(&self, identity: &str, token: &str) {
        fs::write(&self.cp.claude_json, CLAUDE_JSON.replace("claude-account-a", identity)).unwrap();
        fs::write(&self.cp.credentials, owner_credentials(token)).unwrap();
    }

    fn path(&self, id: &str) -> std::path::PathBuf {
        snapshot::snapshot_dir(self.dir.path()).join(format!("{id}.json"))
    }

    fn stored(&self, id: &str) -> snapshot::ClaudeSnapshot {
        match snapshot::load(self.dir.path(), id).unwrap() {
            snapshot::StoredSnapshot::Claude(stored) => stored,
            _ => panic!("expected Claude"),
        }
    }

    fn tick(&self, stamps: &mut live_sync::FileStamps, lookup: OwnerLookup) -> live_sync::SyncOutcome {
        live_sync::sync_provider(self.dir.path(), CliProvider::Claude, &self.cp, &self.xp, stamps, lookup)
    }

    fn switch(&self, id: &str, lookup: OwnerLookup) -> Result<CliSwitchResult, String> {
        switch_account(self.dir.path(), &self.cp, &self.xp, CliProvider::Claude, id, lookup)
    }

    fn live_bytes(&self) -> (Vec<u8>, Vec<u8>) {
        (fs::read(&self.cp.credentials).unwrap(), fs::read(&self.cp.claude_json).unwrap())
    }
}

#[test]
fn classify_claude_live_filing_table() {
    let mut x = test_profile("claude-x"); x.identity_key = "X".into();
    let profiles = [x.clone()];
    assert_eq!(classify_claude_live("P", &owner_credentials("p-access"), &profiles, &owner_lookup), ClaudeLiveFiling::Claimed);
    assert_eq!(classify_claude_live("P", &owner_credentials("x-live"), &profiles, &owner_lookup),
        ClaudeLiveFiling::ToOwner { profile_id: x.id, owner: synthetic_owner("X") });
    assert_eq!(classify_claude_live("P", &owner_credentials("x-live"), &[], &owner_lookup),
        ClaudeLiveFiling::ForeignUnregistered(synthetic_owner("X")));
    assert_eq!(classify_claude_live("P", "{}", &profiles, &owner_lookup), ClaudeLiveFiling::Unverified);
    assert_eq!(classify_claude_live("P", &owner_credentials("p-access"), &profiles, &|_| None), ClaudeLiveFiling::Unverified);
    let mut codex = profiles[0].clone(); codex.provider = CliProvider::Codex;
    assert!(matches!(classify_claude_live("P", &owner_credentials("x-live"), &[codex], &owner_lookup), ClaudeLiveFiling::ForeignUnregistered(_)));
}

#[test]
fn live_sync_files_mismatched_tokens_only_to_the_owner() {
    let c = OwnerCase::new();
    let p_before = fs::read(c.path(&c.p.id)).unwrap();
    let x_name = c.stored(&c.x.id).oauth_account_text;
    record_refresh_rejection(c.dir.path(), &c.x.id, "old".into()).unwrap();
    record_foreign_token_owner(c.dir.path(), &c.x.id, &synthetic_owner("P"), "old".into()).unwrap();
    assert_eq!(c.tick(&mut live_sync::FileStamps::new(), &owner_lookup), live_sync::SyncOutcome::FiledToOwner(c.x.id.clone()));
    assert_eq!(fs::read(c.path(&c.p.id)).unwrap(), p_before);
    assert_eq!(c.stored(&c.x.id).credentials_text, owner_credentials("x-live"));
    assert_eq!(c.stored(&c.x.id).oauth_account_text, x_name);
    let profiles = registry::load(c.dir.path()).unwrap().profiles;
    let x = profiles.iter().find(|profile| profile.id == c.x.id).unwrap();
    assert!(x.foreign_token_owner.is_none() && x.refresh_rejected_at.is_none());
}

#[test]
fn live_sync_unverified_leaves_every_snapshot_and_retries_next_tick() {
    let c = OwnerCase::new();
    let before = (fs::read(c.path(&c.p.id)).unwrap(), fs::read(c.path(&c.x.id)).unwrap(), fs::read(registry::path(c.dir.path())).unwrap());
    let mut stamps = live_sync::FileStamps::new();
    for _ in 0..2 {
        assert_eq!(c.tick(&mut stamps, &|_| None), live_sync::SyncOutcome::Unverified);
    }
    assert_eq!((fs::read(c.path(&c.p.id)).unwrap(), fs::read(c.path(&c.x.id)).unwrap(), fs::read(registry::path(c.dir.path())).unwrap()), before);
    assert_eq!(c.tick(&mut stamps, &owner_lookup), live_sync::SyncOutcome::FiledToOwner(c.x.id.clone()));
}

#[test]
fn live_sync_never_registers_an_unregistered_name_with_foreign_tokens() {
    let c = OwnerCase::new();
    registry::save(c.dir.path(), &registry::CliAccountsFile::default()).unwrap();
    let before = fs::read(registry::path(c.dir.path())).unwrap();
    assert_eq!(c.tick(&mut live_sync::FileStamps::new(), &owner_lookup), live_sync::SyncOutcome::ForeignUnregistered);
    assert_eq!(fs::read(registry::path(c.dir.path())).unwrap(), before);
    assert!(registry::load(c.dir.path()).unwrap().profiles.is_empty());
}

#[test]
fn switch_to_named_profile_preserves_its_real_tokens_and_files_live_to_owner() {
    let c = OwnerCase::new();
    let p_before = fs::read(c.path(&c.p.id)).unwrap();
    let x_name = c.stored(&c.x.id).oauth_account_text;
    let result = c.switch(&c.p.id, &owner_lookup).unwrap();
    assert_eq!(fs::read(c.path(&c.p.id)).unwrap(), p_before);
    assert_eq!(c.stored(&c.x.id).credentials_text, owner_credentials("x-live"));
    assert_eq!(c.stored(&c.x.id).oauth_account_text, x_name);
    assert_eq!(fs::read_to_string(&c.cp.credentials).unwrap(), c.stored(&c.p.id).credentials_text);
    assert_eq!(result.wrote_back_to, Some(c.x.id));
    assert!(result.warnings.contains(&WARN_LIVE_TOKEN_FILED_TO_OWNER.to_string()));
}

#[test]
fn switch_to_token_owner_does_not_poison_the_named_profile() {
    let c = OwnerCase::new();
    let before = fs::read(c.path(&c.p.id)).unwrap();
    let result = c.switch(&c.x.id, &owner_lookup).unwrap();
    assert_eq!(fs::read(c.path(&c.p.id)).unwrap(), before);
    assert_eq!(fs::read_to_string(&c.cp.credentials).unwrap(), owner_credentials("x-live"));
    assert_eq!(claude::read_live_identity(&c.cp).identity_key.as_deref(), Some("X"));
    assert!(result.warnings.contains(&WARN_LIVE_TOKEN_FILED_TO_OWNER.to_string()));
}

#[test]
fn switch_unverified_skips_writeback_and_keeps_backup() {
    let c = OwnerCase::new();
    let before = fs::read(c.path(&c.p.id)).unwrap();
    let live_before = c.live_bytes();
    let result = c.switch(&c.p.id, &|_| None).unwrap();
    assert_eq!(fs::read(c.path(&c.p.id)).unwrap(), before);
    assert_eq!(result.wrote_back_to, None);
    assert!(result.warnings.contains(&WARN_LIVE_TOKEN_NOT_SAVED.to_string()));
    assert_eq!(fs::read(Path::new(&result.backup_dir).join("live-credentials.json")).unwrap(), live_before.0);
}

#[test]
fn switch_rejects_flagged_or_verified_foreign_target_without_live_writes() {
    for flagged in [true, false] {
        let c = OwnerCase::new();
        c.live("X", "x-live");
        if flagged {
            record_foreign_token_owner(c.dir.path(), &c.p.id, &synthetic_owner("X"), "now".into()).unwrap();
        } else {
            replace_claude_credentials(c.dir.path(), &c.p.id, "P", &owner_credentials("x-access")).unwrap();
        }
        let before = c.live_bytes();
        assert_eq!(c.switch(&c.p.id, &owner_lookup).err().as_deref(), Some(ERR_SNAPSHOT_FOREIGN));
        assert_eq!(c.live_bytes(), before);
        assert!(!snapshot::backup_root(c.dir.path()).exists());
        let listed = list(c.dir.path(), &c.cp, &c.xp).unwrap();
        let p = listed.profiles.iter().find(|profile| profile.id == c.p.id).unwrap();
        assert!(p.needs_relogin);
        assert_eq!(p.foreign_token_owner.as_ref().unwrap().account_uuid, "X");
    }
}

#[test]
fn capture_refuses_foreign_and_unverified_live_tokens_without_writes() {
    let c = OwnerCase::new();
    let before = fs::read(registry::path(c.dir.path())).unwrap();
    let p_before = fs::read(c.path(&c.p.id)).unwrap();
    for policy in [UnverifiedPolicy::Refuse, UnverifiedPolicy::Allow] {
        assert_eq!(capture_account(c.dir.path(), &c.cp, &c.xp, CliProvider::Claude, None, &owner_lookup, policy).err().as_deref(), Some(ERR_LIVE_TOKEN_FOREIGN));
    }
    assert_eq!(capture_account(c.dir.path(), &c.cp, &c.xp, CliProvider::Claude, None, &|_| None, UnverifiedPolicy::Refuse).err().as_deref(), Some(ERR_LIVE_TOKEN_UNVERIFIED));
    assert_eq!(fs::read(registry::path(c.dir.path())).unwrap(), before);
    assert_eq!(fs::read(c.path(&c.p.id)).unwrap(), p_before);
}

#[test]
fn verified_capture_and_claimed_sync_clear_both_flags() {
    let c = OwnerCase::new();
    c.live("P", "p-access");
    for capture in [true, false] {
        record_foreign_token_owner(c.dir.path(), &c.p.id, &synthetic_owner("X"), "old".into()).unwrap();
        record_refresh_rejection(c.dir.path(), &c.p.id, "old".into()).unwrap();
        if capture {
            capture_account(c.dir.path(), &c.cp, &c.xp, CliProvider::Claude, None, &owner_lookup, UnverifiedPolicy::Refuse).unwrap();
        } else {
            assert_eq!(c.tick(&mut live_sync::FileStamps::new(), &owner_lookup), live_sync::SyncOutcome::Resynced(c.p.id.clone()));
        }
        let profiles = list(c.dir.path(), &c.cp, &c.xp).unwrap().profiles;
        let p = profiles.iter().find(|profile| profile.id == c.p.id).unwrap();
        assert!(p.foreign_token_owner.is_none() && p.refresh_rejected_at.is_none() && !p.needs_relogin);
    }
}

#[test]
fn switch_foreign_unregistered_or_missing_owner_snapshot_keeps_named_copy() {
    for registered in [false, true] {
        let c = OwnerCase::new();
        if registered {
            fs::write(c.path(&c.x.id), "{}").unwrap();
        } else {
            let mut file = registry::load(c.dir.path()).unwrap();
            file.profiles.retain(|profile| profile.id != c.x.id);
            registry::save(c.dir.path(), &file).unwrap();
        }
        let before = fs::read(c.path(&c.p.id)).unwrap();
        let result = c.switch(&c.p.id, &owner_lookup).unwrap();
        assert_eq!(fs::read(c.path(&c.p.id)).unwrap(), before);
        assert!(result.warnings.contains(&if registered { WARN_LIVE_TOKEN_NOT_SAVED } else { WARN_LIVE_TOKEN_FOREIGN_UNREGISTERED }.to_string()));
        assert!(result.wrote_back_to.is_none());
    }
}

#[test]
fn captured_identity_bytes_must_match_the_filing_key() {
    let c = OwnerCase::new();
    let stored = c.stored(&c.p.id);
    assert!(claude_snapshot_names(&stored, "P"));
    assert!(!claude_snapshot_names(&stored, "X"));
    assert!(!claude_snapshot_names(&snapshot::ClaudeSnapshot { oauth_account_text: "{}".into(), ..stored }, "P"));
}

#[test]
fn owner_filing_refuses_broken_embedded_snapshot_metadata() {
    let c = OwnerCase::new();
    let broken = snapshot::StoredSnapshot::Claude(snapshot::ClaudeSnapshot {
        oauth_account_text: "{}".into(), ..c.stored(&c.x.id)
    });
    snapshot::save(c.dir.path(), &c.x.id, &broken).unwrap();
    let before = fs::read(c.path(&c.x.id)).unwrap();
    assert!(replace_claude_credentials(c.dir.path(), &c.x.id, "X", &owner_credentials("x-live")).is_err());
    assert_eq!(fs::read(c.path(&c.x.id)).unwrap(), before);
}

#[test]
fn owner_filing_refuses_a_destination_that_names_someone_else() {
    // Moving X's tokens into a copy whose identity bytes say P would recreate
    // the very split this filing exists to repair.
    let c = OwnerCase::new();
    let before = fs::read(c.path(&c.p.id)).unwrap();
    assert!(replace_claude_credentials(c.dir.path(), &c.p.id, "X", &owner_credentials("x-live")).is_err());
    assert_eq!(fs::read(c.path(&c.p.id)).unwrap(), before);
}

#[test]
fn switch_is_not_refused_on_a_flag_its_own_write_back_just_cleared() {
    // The live login is the target's own and verified: the write-back refreshes
    // the target's copy and clears its foreign flag, so the switch must not be
    // refused on the copy of the flag read before the write-back ran.
    let c = OwnerCase::new();
    c.live("P", "p-access");
    record_foreign_token_owner(c.dir.path(), &c.p.id, &synthetic_owner("X"), "old".into()).unwrap();
    let result = c.switch(&c.p.id, &owner_lookup).unwrap();
    assert_eq!(result.wrote_back_to.as_deref(), Some(c.p.id.as_str()));
    let profiles = registry::load(c.dir.path()).unwrap().profiles;
    let p = profiles.iter().find(|profile| profile.id == c.p.id).unwrap();
    assert!(p.foreign_token_owner.is_none());
}

#[test]
fn codex_and_grok_capture_switch_never_consult_claude_owner_lookup() {
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let dir = tempdir().unwrap();
        let cp = ClaudePaths { store: claude::CredentialStore::File,
            credentials: dir.path().join("claude-credentials.json"), claude_json: dir.path().join("claude-name.json") };
        let xp = CodexPaths { auth: dir.path().join("codex-auth.json") };
        let gp = grok::GrokPaths { auth: dir.path().join("grok-auth.json"), lock: dir.path().join("grok-auth.lock") };
        fs::write(&xp.auth, CODEX).unwrap();
        fs::write(&gp.auth, GROK).unwrap();
        let forbidden_lookup = |_: &str| -> Option<TokenOwner> { panic!("Claude lookup must not run for Codex/Grok") };
        let profile = capture_account_with_grok(dir.path(), &cp, &xp, Some(&gp), provider, None, &forbidden_lookup, UnverifiedPolicy::Refuse).unwrap();
        let result = switch_account_with_grok(dir.path(), &cp, &xp, Some(&gp), provider, &profile.id, &forbidden_lookup).unwrap();
        assert_eq!(result.wrote_back_to.as_deref(), Some(profile.id.as_str()));
        assert!(result.warnings.contains(&WARN_ACTIVE_SNAPSHOT_REFRESHED.to_string()));
        assert!(result.profile.foreign_token_owner.is_none());
        assert!(!cp.credentials.exists() && !cp.claude_json.exists());
    }
}
