use super::*;
use std::{cell::Cell, fs};
fn status() -> LaunchTokenStatus {
    LaunchTokenStatus { profile_id: "claude-fixture".into(), registered_at: "2026-11-11T00:00:00Z".into(),
        expires_at: "2027-11-11T00:00:00Z".into(), fingerprint: "0123456789".into(),
        owner_check: OwnerCheckStatus::Verified, owner_check_status: None,
        owner_checked_at: Some("2026-11-12T00:00:00Z".into()), owner_method: Some("profile".into()) }
}
fn write_status(base: &Path, status: &LaunchTokenStatus) {
    fs::write(base.join("cli_account_launch_tokens.json"), serde_json::to_vec(&vec![status]).unwrap()).unwrap();
}
fn home(provider: CliProvider) -> TabAccountEvidence {
    TabAccountEvidence { provider, profile_id: "home-fixture".into(), method: EvidenceMethod::AccountHome,
        result: EvidenceResult::Matched, checked_at: "2026-11-12T00:00:00Z".into(), launched_at: "2026-11-12T00:01:00Z".into(),
        fingerprint: None, owner_email: Some("fixture@example.test".into()), owner_method: None, owner_check_status: None }
}

#[test]
fn v2_claude_launch_snapshot_current_recheck_and_replacement_stale() {
    let base = tempfile::tempdir().unwrap();
    let mut current = status(); write_status(base.path(), &current);
    let initial = TabAccountEvidence::claude(&current);
    assert_eq!(initial.fingerprint.as_deref(), Some("0123456789"));
    assert_eq!(initial.checked_at, current.owner_checked_at.clone().unwrap());
    remember(base.path(), "pty", initial.clone(), |_| true);
    assert_eq!(get(base.path(), "pty", |_| true).unwrap().unwrap(), initial);
    for check in [OwnerCheckStatus::OrgMatched, OwnerCheckStatus::OrgShared, OwnerCheckStatus::Unverified, OwnerCheckStatus::Mismatch] {
        current.owner_check = check;
        current.owner_checked_at = Some("2026-11-12T01:00:00Z".into());
        write_status(base.path(), &current);
        let result = get(base.path(), "pty", |_| true).unwrap().unwrap();
        assert_eq!(result.result, (&current.owner_check).into());
        assert_eq!(result.checked_at, "2026-11-12T01:00:00Z");
        assert_eq!(result.launched_at, initial.launched_at);
    }
    current.fingerprint = "9876543210".into(); write_status(base.path(), &current);
    let result = get(base.path(), "pty", |_| true).unwrap().unwrap();
    assert_eq!(result.result, EvidenceResult::Stale);
    assert_eq!(result.fingerprint, initial.fingerprint);
    assert_eq!(result.checked_at, initial.checked_at);
}


#[test]
fn fix1_claude_status_code_follows_the_matching_token_but_stale_keeps_the_launch_copy() {
    let base = tempfile::tempdir().unwrap();
    let mut current = status();
    current.owner_check = OwnerCheckStatus::Unverified;
    current.owner_method = None;
    current.owner_check_status = Some(403);
    write_status(base.path(), &current);
    let initial = TabAccountEvidence::claude(&current);
    assert_eq!(initial.owner_check_status, Some(403));
    assert_eq!(serde_json::to_value(&initial).unwrap()["owner_check_status"], 403);
    remember(base.path(), "pty", initial.clone(), |_| true);
    assert_eq!(get(base.path(), "pty", |_| true).unwrap().unwrap().owner_check_status, Some(403));

    current.owner_check_status = Some(429);
    write_status(base.path(), &current);
    let updated = get(base.path(), "pty", |_| true).unwrap().unwrap();
    assert_eq!(updated.result, EvidenceResult::Unverified);
    assert_eq!(updated.owner_check_status, Some(429));

    current.owner_check_status = None;
    write_status(base.path(), &current);
    let absent = get(base.path(), "pty", |_| true).unwrap().unwrap();
    assert_eq!(absent.owner_check_status, None);
    assert!(serde_json::to_value(&absent).unwrap().get("owner_check_status").is_none());

    current.fingerprint = "9876543210".into();
    current.owner_check_status = Some(503);
    write_status(base.path(), &current);
    let stale = get(base.path(), "pty", |_| true).unwrap().unwrap();
    assert_eq!(stale.result, EvidenceResult::Stale);
    assert_eq!(stale.owner_check_status, Some(403));
    assert_eq!(stale.fingerprint, initial.fingerprint);
    assert_eq!(stale.checked_at, initial.checked_at);
}

#[test]
fn fix1_homes_and_a_claude_check_without_status_omit_the_optional_serialized_field() {
    let base = tempfile::tempdir().unwrap();
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let context = account_homes::test_context(provider, base.path().into());
        let evidence = TabAccountEvidence::home(&context);
        assert_eq!(evidence.owner_check_status, None);
        assert!(serde_json::to_value(&evidence).unwrap().get("owner_check_status").is_none());
    }
    let evidence = TabAccountEvidence::claude(&status());
    assert_eq!(evidence.owner_check_status, None);
    assert!(serde_json::to_value(&evidence).unwrap().get("owner_check_status").is_none());
}

#[test]
fn v2_same_session_reattachment_retains_evidence_and_exit_prunes_without_persistence() {
    let base = tempfile::tempdir().unwrap();
    let record = home(CliProvider::Codex);
    remember(base.path(), "same-pty", record.clone(), |_| true);
    for _ in ["move", "detach", "background", "reattach"] {
        assert_eq!(get(base.path(), "same-pty", |_| true).unwrap(), Some(record.clone()));
    }
    assert_eq!(fs::read_dir(base.path()).unwrap().count(), 0);
    assert_eq!(get(base.path(), "same-pty", |_| false).unwrap(), None);
    assert_eq!(get(base.path(), "same-pty", |_| true).unwrap(), None);
    remember(base.path(), "failed-spawn", record, |_| false);
    assert_eq!(get(base.path(), "failed-spawn", |_| true).unwrap(), None);
}

#[test]
fn v2_bases_are_isolated_and_default_tabs_have_no_evidence_or_io() {
    let first = tempfile::tempdir().unwrap(); let second = tempfile::tempdir().unwrap();
    remember(first.path(), "pty", home(CliProvider::Grok), |_| true);
    assert_eq!(get(second.path(), "pty", |_| true).unwrap(), None);
    assert_eq!(get(&second.path().join("absent"), "default", |_| true).unwrap(), None);
    assert_eq!(recheck_with(second.path(), "default", |_| true,
        |_| panic!("default must not check a token"), |_,_| panic!("default must not read auth")).unwrap(), None);
}

#[test]
fn v2_home_recheck_records_email_mismatch_and_recovery_for_both_providers() {
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let base = tempfile::tempdir().unwrap();
        let initial = home(provider);
        remember(base.path(), "pty", initial.clone(), |_| true);
        let matched = recheck_with(base.path(), "pty", |_| true, |_| panic!("home cannot read a launch token"), |p,id| {
            assert_eq!(p, provider); assert_eq!(id, "home-fixture"); Ok(Some("checked@example.test".into()))
        }).unwrap().unwrap();
        assert_eq!(matched.result, EvidenceResult::Matched);
        assert_eq!(matched.owner_email.as_deref(), Some("checked@example.test"));
        assert_eq!(matched.launched_at, initial.launched_at);
        let mismatch = recheck_with(base.path(), "pty", |_| true, |_| panic!("no token"), |_,_| Err(account_homes::ERR_HOME_OWNER_MISMATCH.into())).unwrap().unwrap();
        assert_eq!(mismatch.result, EvidenceResult::Mismatch);
        assert_eq!(mismatch.owner_email, None);
        assert_eq!(get(base.path(), "pty", |_| true).unwrap(), Some(mismatch.clone()));
        let error = recheck_with(base.path(), "pty", |_| true, |_| panic!("no token"), |_,_| Err(account_homes::ERR_HOME_NOT_READY.into())).unwrap_err();
        assert_eq!(error, account_homes::ERR_HOME_NOT_READY);
        assert_eq!(get(base.path(), "pty", |_| true).unwrap(), Some(mismatch));
        let recovered = recheck_with(base.path(), "pty", |_| true, |_| panic!("no token"), |_,_| Ok(None)).unwrap().unwrap();
        assert_eq!(recovered.result, EvidenceResult::Matched);
        assert_eq!(recovered.owner_email, None);
        let wire = serde_json::to_string(&recovered).unwrap();
        assert!(!wire.contains("token"));
        assert!(!wire.contains("auth.json"));
        assert!(!wire.contains(base.path().to_str().unwrap()));
    }
}

#[test]
fn v2_claude_recheck_returns_new_confirmation_but_keeps_stale_launch_fingerprint() {
    let base = tempfile::tempdir().unwrap();
    let mut current = status(); write_status(base.path(), &current);
    let initial = TabAccountEvidence::claude(&current);
    remember(base.path(), "pty", initial, |_| true);
    let result = recheck_with(base.path(), "pty", |_| true, |id| {
        assert_eq!(id, current.profile_id);
        current.owner_check = OwnerCheckStatus::Mismatch; write_status(base.path(), &current); Ok(current.clone())
    }, |_,_| panic!("Claude cannot read home auth")).unwrap().unwrap();
    assert_eq!(result.result, EvidenceResult::Mismatch);
    current.fingerprint = "newerprint".into(); write_status(base.path(), &current);
    let result = recheck_with(base.path(), "pty", |_| true, |_| {
        current.owner_check = OwnerCheckStatus::Verified; write_status(base.path(), &current); Ok(current.clone())
    }, |_,_| panic!("no home")).unwrap().unwrap();
    assert_eq!(result.result, EvidenceResult::Stale);
}

#[test]
fn v2_recheck_cannot_resurrect_an_exited_session() {
    let base = tempfile::tempdir().unwrap(); let alive = Cell::new(true);
    remember(base.path(), "pty", home(CliProvider::Codex), |_| alive.get());
    assert_eq!(recheck_with(base.path(), "pty", |_| alive.get(), |_| panic!("no token"),
        |_,_| { alive.set(false); Ok(None) }).unwrap(), None);
    alive.set(true);
    assert_eq!(get(base.path(), "pty", |_| alive.get()).unwrap(), None);
}

#[test]
fn rc02_legacy_recheck_records_mismatch_when_requesting_session_exits() {
    let base = tempfile::tempdir().unwrap();
    let alive_a = Cell::new(true);
    let alive = |id: &str| id != "pty-a" || alive_a.get();
    let mut current = status();
    write_status(base.path(), &current);
    let initial = TabAccountEvidence::claude(&current);
    remember(base.path(), "pty-a", initial.clone(), &alive);
    remember(base.path(), "pty-b", initial.clone(), &alive);

    let result = recheck(base.path(), "pty-a", &alive, |id| {
        assert_eq!(id, current.profile_id);
        alive_a.set(false);
        current.owner_check = OwnerCheckStatus::Mismatch;
        write_status(base.path(), &current);
        Ok(current.clone())
    });
    assert_eq!(result.unwrap(), None);
    assert_eq!(launch_tokens::status_all(base.path()).unwrap()[0].owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(get(base.path(), "pty-b", &alive).unwrap().unwrap().result, EvidenceResult::Mismatch);
    assert_eq!(get(base.path(), "pty-a", &alive).unwrap(), None);
    alive_a.set(true);
    assert_eq!(get(base.path(), "pty-a", &alive).unwrap(), None);
    let sibling = get(base.path(), "pty-b", &alive).unwrap().unwrap();
    assert_eq!(sibling.result, EvidenceResult::Mismatch);
    assert_eq!(sibling.launched_at, initial.launched_at);
    assert_eq!(sibling.fingerprint, initial.fingerprint);
}

#[test]
fn rc02_outcome_retains_saved_profile_when_requesting_session_exits() {
    let base = tempfile::tempdir().unwrap();
    let alive_a = Cell::new(true);
    let alive = |id: &str| id != "pty-a" || alive_a.get();
    let mut current = status();
    write_status(base.path(), &current);
    let initial = TabAccountEvidence::claude(&current);
    remember(base.path(), "pty-a", initial.clone(), &alive);
    remember(base.path(), "pty-b", initial.clone(), &alive);

    let outcome: TabRecheckOutcome = recheck_with_outcome(base.path(), "pty-a", &alive, |id| {
        assert_eq!(id, current.profile_id);
        alive_a.set(false);
        current.owner_check = OwnerCheckStatus::Mismatch;
        write_status(base.path(), &current);
        Ok(current.clone())
    });
    assert_eq!(outcome.token_record_saved_for.as_deref(), Some(current.profile_id.as_str()));
    assert_eq!(outcome.result.unwrap(), None);
    assert_eq!(launch_tokens::status_all(base.path()).unwrap()[0].owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(get(base.path(), "pty-a", &alive).unwrap(), None);
    let sibling = get(base.path(), "pty-b", &alive).unwrap().unwrap();
    assert_eq!(sibling.result, EvidenceResult::Mismatch);
    assert_eq!(sibling.fingerprint, initial.fingerprint);
    assert_eq!(sibling.launched_at, initial.launched_at);
    alive_a.set(true);
    assert_eq!(get(base.path(), "pty-a", &alive).unwrap(), None);
    assert_eq!(get(base.path(), "pty-b", &alive).unwrap(), Some(sibling));
}

#[test]
fn rc02_outcome_retains_saved_profile_after_status_read_failure() {
    let base = tempfile::tempdir().unwrap();
    let mut current = status();
    write_status(base.path(), &current);
    let initial = TabAccountEvidence::claude(&current);
    remember(base.path(), "pty-a", initial.clone(), |_| true);
    remember(base.path(), "pty-b", initial, |_| true);
    let saved = Cell::new(false);

    let outcome = recheck_with_outcome(base.path(), "pty-a", |_| true, |id| {
        assert_eq!(id, current.profile_id);
        current.owner_check = OwnerCheckStatus::Mismatch;
        write_status(base.path(), &current);
        assert_eq!(launch_tokens::status_all(base.path()).unwrap()[0].owner_check, OwnerCheckStatus::Mismatch);
        saved.set(true);
        fs::write(base.path().join("cli_account_launch_tokens.json"), b"{invalid-json").unwrap();
        Ok(current.clone())
    });
    assert!(saved.get());
    assert_eq!(outcome.token_record_saved_for.as_deref(), Some(current.profile_id.as_str()));
    assert_eq!(outcome.result.unwrap_err(), super::super::ERR_ACCOUNTS_UNAVAILABLE);
    assert_eq!(launch_tokens::status_all(base.path()).unwrap_err(), super::super::ERR_ACCOUNTS_UNAVAILABLE);
    write_status(base.path(), &current);
    assert_eq!(get(base.path(), "pty-b", |_| true).unwrap().unwrap().result, EvidenceResult::Mismatch);
}

#[test]
fn rc02_outcome_does_not_mark_token_saved_when_check_fails() {
    for exits in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let alive_a = Cell::new(true);
        let alive = |id: &str| id != "pty-a" || alive_a.get();
        let current = status();
        write_status(base.path(), &current);
        let before = fs::read(base.path().join("cli_account_launch_tokens.json")).unwrap();
        let initial = TabAccountEvidence::claude(&current);
        remember(base.path(), "pty-a", initial.clone(), &alive);
        remember(base.path(), "pty-b", initial.clone(), &alive);
        let called = Cell::new(false);
        let outcome = recheck_with_outcome(base.path(), "pty-a", &alive, |id| {
            assert_eq!(id, current.profile_id);
            called.set(true);
            if exits { alive_a.set(false); }
            Err(super::super::ERR_REGISTRY_SAVE_FAILED.into())
        });
        assert!(called.get());
        assert_eq!(outcome.token_record_saved_for, None);
        assert_eq!(outcome.result.unwrap_err(), super::super::ERR_REGISTRY_SAVE_FAILED);
        assert_eq!(fs::read(base.path().join("cli_account_launch_tokens.json")).unwrap(), before);
        assert_eq!(get(base.path(), "pty-b", &alive).unwrap(), Some(initial.clone()));
        assert_eq!(get(base.path(), "pty-a", &alive).unwrap(), if exits { None } else { Some(initial.clone()) });
        alive_a.set(true);
        assert_eq!(get(base.path(), "pty-a", &alive).unwrap(), if exits { None } else { Some(initial) });
    }
}

#[test]
fn rc02_outcome_reports_saved_profile_and_live_mismatch_evidence() {
    let base = tempfile::tempdir().unwrap();
    let mut current = status();
    write_status(base.path(), &current);
    let initial = TabAccountEvidence::claude(&current);
    remember(base.path(), "pty-a", initial.clone(), |_| true);
    remember(base.path(), "pty-b", initial.clone(), |_| true);
    let called = Cell::new(false);
    let outcome = recheck_with_outcome(base.path(), "pty-a", |_| true, |id| {
        assert_eq!(id, current.profile_id);
        called.set(true);
        current.owner_check = OwnerCheckStatus::Mismatch;
        current.owner_checked_at = Some("2026-11-13T00:00:00Z".into());
        write_status(base.path(), &current);
        Ok(current.clone())
    });
    assert!(called.get());
    assert_eq!(outcome.token_record_saved_for.as_deref(), Some(current.profile_id.as_str()));
    let evidence = outcome.result.unwrap().unwrap();
    assert_eq!(evidence.result, EvidenceResult::Mismatch);
    assert_eq!(evidence.profile_id, current.profile_id);
    assert_eq!(evidence.checked_at, current.owner_checked_at.unwrap());
    assert_eq!(evidence.fingerprint, initial.fingerprint);
    assert_eq!(evidence.launched_at, initial.launched_at);
    assert_eq!(get(base.path(), "pty-a", |_| true).unwrap(), Some(evidence));
    assert_eq!(get(base.path(), "pty-b", |_| true).unwrap().unwrap().result, EvidenceResult::Mismatch);
}

#[test]
fn rc02_home_outcome_preserves_matching_mismatch_and_other_errors() {
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        for exits in [false, true] {
            for check in ["matched-email", "matched-none", "mismatch", "other-error"] {
                let base = tempfile::tempdir().unwrap();
                let alive_a = Cell::new(true);
                let alive = |id: &str| id != "pty-a" || alive_a.get();
                let initial = home(provider);
                remember(base.path(), "pty-a", initial.clone(), &alive);
                remember(base.path(), "pty-b", initial.clone(), &alive);
                let outcome = recheck_with_outcome_and_home(base.path(), "pty-a", &alive,
                    |_| panic!("home cannot check a launch token"), |p, id| {
                        assert_eq!(p, provider);
                        assert_eq!(id, initial.profile_id);
                        if exits { alive_a.set(false); }
                        match check {
                            "matched-email" => Ok(Some("checked@example.test".into())),
                            "matched-none" => Ok(None),
                            "mismatch" => Err(account_homes::ERR_HOME_OWNER_MISMATCH.into()),
                            _ => Err(account_homes::ERR_HOME_NOT_READY.into()),
                        }
                    });
                assert_eq!(outcome.token_record_saved_for, None);
                if check == "other-error" {
                    assert_eq!(outcome.result.unwrap_err(), account_homes::ERR_HOME_NOT_READY);
                    assert_eq!(get(base.path(), "pty-a", &alive).unwrap(), if exits { None } else { Some(initial.clone()) });
                } else if exits {
                    assert_eq!(outcome.result.unwrap(), None);
                } else {
                    let evidence = outcome.result.unwrap().unwrap();
                    assert_eq!(evidence.result, if check == "mismatch" { EvidenceResult::Mismatch } else { EvidenceResult::Matched });
                    assert_eq!(evidence.owner_email.as_deref(), if check == "matched-email" { Some("checked@example.test") } else { None });
                    assert_eq!(evidence.launched_at, initial.launched_at);
                    assert_eq!(get(base.path(), "pty-a", &alive).unwrap(), Some(evidence));
                }
                assert_eq!(get(base.path(), "pty-b", &alive).unwrap(), Some(initial));
                assert_eq!(fs::read_dir(base.path()).unwrap().count(), 0);
                if exits {
                    alive_a.set(true);
                    assert_eq!(get(base.path(), "pty-a", &alive).unwrap(), None);
                }
            }
        }
    }
}

#[test]
fn rc02_outcome_skips_check_for_an_absent_or_exited_session() {
    for exited in [false, true] {
        let base = tempfile::tempdir().unwrap();
        if exited { remember(base.path(), "pty-a", TabAccountEvidence::claude(&status()), |_| true); }
        fs::write(base.path().join("cli_account_launch_tokens.json"), b"{invalid-json").unwrap();
        let outcome = recheck_with_outcome(base.path(), "pty-a", |_| !exited,
            |_| panic!("absent evidence must not check a token"));
        assert_eq!(outcome.token_record_saved_for, None);
        assert_eq!(outcome.result.unwrap(), None);
        assert_eq!(get(base.path(), "pty-a", |_| true).unwrap(), None);
    }
}

#[test]
fn rc02_outcome_preserves_initial_status_read_error_without_checking() {
    let base = tempfile::tempdir().unwrap();
    let current = status();
    remember(base.path(), "pty-a", TabAccountEvidence::claude(&current), |_| true);
    fs::write(base.path().join("cli_account_launch_tokens.json"), b"{invalid-json").unwrap();
    let outcome = recheck_with_outcome(base.path(), "pty-a", |_| true,
        |_| panic!("failed initial read must not check a token"));
    assert_eq!(outcome.token_record_saved_for, None);
    assert_eq!(outcome.result.unwrap_err(), super::super::ERR_ACCOUNTS_UNAVAILABLE);
    write_status(base.path(), &current);
    assert_eq!(get(base.path(), "pty-a", |_| true).unwrap().unwrap().result, EvidenceResult::Verified);
}
