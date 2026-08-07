use super::*;
use super::{claude::ClaudePaths, codex::CodexPaths, json_splice::*};
use std::fs;
use tempfile::tempdir;

const CLAUDE_JSON: &str = include_str!("fixtures/claude_json_sample.json");
const CREDS: &str = include_str!("fixtures/claude_credentials_sample.json");
const CODEX: &str = include_str!("fixtures/codex_auth_sample.json");
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
fn claude_identity_and_relogin() {
    let d = tempdir().unwrap();
    let p = ClaudePaths {
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
    };
    registry::upsert_by_identity_key(&mut f, p);
    registry::save(d.path(), &f).unwrap();
    assert_eq!(registry::load(d.path()).unwrap().profiles.len(), 1);
    fs::write(d.path().join("cli_accounts.json"), "{}").unwrap();
    assert!(registry::load(d.path()).unwrap().profiles.is_empty());
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
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let first = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None).unwrap();
    let changed = CLAUDE_JSON
        .replace("claude-account-a", "claude-account-b")
        .replace("a@example.test", "b@example.test");
    fs::write(&cp.claude_json, &changed).unwrap();
    let second = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    switch_account(d.path(), &cp, &xp, CliProvider::Claude, &second.id).unwrap();
    assert!(fs::read_to_string(&cp.claude_json)
        .unwrap()
        .contains("claude-account-b"));
    assert!(snapshot::load(d.path(), &first.id).is_ok());
    assert!(d.path().join("cli_account_backups").is_dir());
}
#[test]
fn switch_writes_orphan_snapshot_for_unregistered_live_login() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let target = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None).unwrap();
    let changed = CLAUDE_JSON.replace("claude-account-a", "other");
    fs::write(&cp.claude_json, changed).unwrap();
    switch_account(d.path(), &cp, &xp, CliProvider::Claude, &target.id).unwrap();
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
#[test]
fn rename_resolved_changes_only_label() {
    let d = tempdir().unwrap();
    let profile = test_profile("claude-12345678");
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
}

#[test]
fn list_recomputes_relogin_without_rewriting_registry() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
        credentials: d.path().join("credentials.json"),
        claude_json: d.path().join("claude.json"),
    };
    let xp = CodexPaths {
        auth: d.path().join("auth.json"),
    };
    fs::write(&cp.credentials, CREDS).unwrap();
    fs::write(&cp.claude_json, CLAUDE_JSON).unwrap();
    let profile = capture_account(d.path(), &cp, &xp, CliProvider::Claude, None).unwrap();
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
fn list_exposes_intended_active_pointer() {
    let d = tempdir().unwrap();
    let cp = ClaudePaths {
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
