use super::*;
use crate::pty::manager::{SessionManager, TrustedAgentIdentity};
use crate::pty::monitor::{new_metadata_store, PtyMetadata};
use serde_json::json;
use std::path::PathBuf;

fn state(cwd: &str) -> crate::AppState {
    let manager = Arc::new(SessionManager::new());
    let metadata = new_metadata_store();
    manager.install_fixture_owner("pty-a", 0, Duration::from_secs(20), metadata.clone());
    let mut row = PtyMetadata::unobserved("pty-a".into());
    row.session_epoch = manager.session_observation("pty-a").unwrap().0;
    row.cwd = cwd.into(); row.live_agent_kind = Some("codex".into()); row.agent_kind = Some("codex".into());
    row.agent_started_at = Some(1791964820000); row.agent_pid = Some(222);
    metadata.insert("pty-a".into(), row);
    let store = crate::session_state::SessionStateStore::new();
    crate::AppState {
        session_manager:manager.clone(), scrollback_dir:OnceLock::new(), session_state_store:store.clone(),
        status_feed:crate::status_feed::StatusFeed::new(store.clone()),
        frontend_visible:Arc::new(std::sync::atomic::AtomicBool::new(false)), metadata_store:metadata.clone(),
        livebrief_service:crate::livebrief::LiveBriefService::new(manager.clone(), metadata),
        hook_service:crate::agent_state::HookService::with_session_manager(store, manager),
        window_registry:crate::window_registry::WindowRegistry::new(),
    }
}
fn request(cwd: &str) -> NamingRequest {
    NamingRequest { title:TitleRequest {tab_id:"a".into(), agent_kind:"codex".into(), agent_session_id:None, cwd:cwd.into()},
        pty_session_id:"pty-a".into(), codex_lookup:None, waiting_for_agent:false }
}
fn record(root: &Path, id: &str, cwd: &str, prompt: &str) -> PathBuf {
    std::fs::create_dir_all(root).unwrap();
    let path = root.join(format!("rollout-{id}.jsonl"));
    let header = json!({"type":"session_meta", "timestamp":"2026-10-14T08:00:00Z", "payload":{"id":id,"cwd":cwd,"source":"cli"}});
    let user = json!({"type":"response_item", "timestamp":"2026-10-14T08:00:01Z", "payload":{"type":"message","role":"user","content":prompt}});
    std::fs::write(&path, format!("{}\n{}\n", header, user)).unwrap(); path
}
#[test]
fn fix2_f01_appstate_metadata_and_disk_do_not_claim_an_ended_peer() {
    let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
    let cwd = "C:/shared/work"; let state = state(cwd);
    record(&home.path().join(".codex/sessions/2026/10/14"), "owner-b", cwd, "Peer B's job");
    let mut request = request(cwd); observe_request(&mut request, &state);
    assert!(request.codex_lookup.as_ref().unwrap().session_id.is_none());
    let material = fallback(request, Instant::now() + Duration::from_secs(5));
    assert_eq!(material.material_status.as_deref(), Some("unverified"));
    assert!(material.record_owner.is_none()); assert!(material.initial_instruction.is_none()); assert!(material.events.is_empty());
}
#[test]
fn fix2_f06_appstate_reports_incomplete_instead_of_a_readable_peer() {
    let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
    let cwd = "C:/shared/work"; let state = state(cwd); let root = home.path().join(".codex/sessions/2026/10/14");
    record(&root, "owner-b", cwd, "Peer B's job");
    std::fs::write(root.join("rollout-owner-a.jsonl"), b"{\"type\":\"session_meta\",\"payload\":").unwrap();
    let mut request = request(cwd); observe_request(&mut request, &state);
    let material = fallback(request, Instant::now() + Duration::from_secs(5));
    assert_eq!(material.material_status.as_deref(), Some("incomplete")); assert!(material.record_owner.is_none());
}
#[test]
fn fix2_f02_shared_cwd_spec_is_never_seat_owned_material() {
    let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
    let cwd = home.path().to_string_lossy(); let state = state(&cwd);
    std::fs::write(home.path().join("spec.md"), "# date-fix\n").unwrap();
    let mut request = request(&cwd); observe_request(&mut request, &state);
    let material = fallback(request, Instant::now() + Duration::from_secs(5));
    assert!(material.task_title.is_none()); assert!(!material.task_title_explicit); assert!(material.task_title_input.is_none());
}
#[test]
fn fix2_confirmed_process_uuid_keeps_explicit_spec_and_input_generation() {
    let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
    let cwd = home.path().to_string_lossy(); let state = state(&cwd);
    let spec = home.path().join("owned-spec.md"); std::fs::write(&spec, "# owned date-fix\n").unwrap();
    record(&home.path().join(".codex/sessions/2026/10/14"), "owner-a", &cwd, &format!("Read \"{}\"", spec.display()));
    state.session_manager.remember_agent_identity("pty-a", TrustedAgentIdentity {
        session_epoch:state.session_manager.session_observation("pty-a").unwrap().0,
        kind:"codex".into(), session_id:"owner-a".into(), agent_pid:222, agent_started_at:1791964820, from_hook:true,
    });
    let mut request = request(&cwd); observe_request(&mut request, &state);
    let material = fallback(request, Instant::now() + Duration::from_secs(5));
    assert!(material.agent_session_id.is_none()); assert_eq!(material.record_owner.as_deref(), Some("owner-a"));
    assert_eq!(material.task_title.as_deref(), Some("owned date-fix")); assert!(material.task_title_explicit);
    let initial = material.initial_instruction_source.unwrap(); let spec_source = material.task_title_input.unwrap();
    assert_eq!(initial.event_id, spec_source.event_id); assert_eq!(initial.source_revision, 1);
    assert!(initial.source_byte_start > 0); assert_eq!(initial.source_byte_start, spec_source.source_byte_start);
}
#[test]
fn fix2_f06_reports_a_locked_header_as_incomplete() {
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
        let cwd = "C:/shared/work"; let state = state(cwd); let root = home.path().join(".codex/sessions/2026/10/14");
        record(&root, "owner-b", cwd, "Peer B's job"); let path = record(&root, "owner-a", cwd, "A's job");
        let _lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap();
        let mut request = request(cwd); observe_request(&mut request, &state);
        let material = fallback(request, Instant::now() + Duration::from_secs(5));
        assert_eq!(material.material_status.as_deref(), Some("incomplete")); assert!(material.record_owner.is_none());
    }
}
#[test]
fn fix2_stale_pty_epoch_cannot_use_a_previously_trusted_uuid() {
    let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
    let cwd = "C:/shared/work"; let state = state(cwd);
    state.metadata_store.get_mut("pty-a").unwrap().session_epoch += 1;
    let mut request = request(cwd); observe_request(&mut request, &state);
    assert!(request.codex_lookup.is_none());
    let material = fallback(request, Instant::now() + Duration::from_secs(5));
    assert_eq!(material.material_status.as_deref(), Some("unverified")); assert!(material.record_owner.is_none());
}

#[test]
fn fix2_startup_keeps_waiting_until_process_identity_can_be_observed() {
    let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
    let cwd = "C:/shared/work"; let state = state(cwd);
    state.session_manager.install_fixture_owner("pty-a", 0, Duration::ZERO, state.metadata_store.clone());
    state.metadata_store.clear();
    let mut request = request(cwd); observe_request(&mut request, &state);
    assert!(request.waiting_for_agent); assert!(request.codex_lookup.is_none());
    let material = fallback(request, Instant::now() + Duration::from_secs(5));
    assert_eq!(material.material_status.as_deref(), Some("waiting")); assert!(material.record_owner.is_none());
}


#[test]
fn fix3_r2_01_same_epoch_process_replacement_cannot_use_the_old_uuid() {
    let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
    let cwd = "C:/shared/work"; let state = state(cwd);
    let epoch = state.session_manager.session_observation("pty-a").unwrap().0;
    record(&home.path().join(".codex/sessions/2026/10/14"), "owner-a", cwd,
        "\u{65e5}\u{4ed8}\u{8868}\u{793a}\u{3092}\u{4fee}\u{6b63}\u{3059}\u{308b}");
    state.session_manager.remember_agent_identity("pty-a", TrustedAgentIdentity {
        session_epoch:epoch, kind:"codex".into(), session_id:"owner-a".into(),
        agent_pid:111, agent_started_at:1791964800, from_hook:true,
    });
    state.metadata_store.get_mut("pty-a").unwrap().agent_started_at = Some(1791964900000);
    let mut request = request(cwd); observe_request(&mut request, &state);
    let material = fallback(request, Instant::now() + Duration::from_secs(5));
    assert!(material.record_owner.is_none(), "Old A must not name B in the same PTY epoch: {:?}", material.record_owner);
    assert!(material.initial_instruction.is_none()); assert!(material.events.is_empty());
    assert_eq!(state.session_manager.session_observation("pty-a").unwrap().0, epoch);
}

#[test]
fn fix3_r2_01_monitor_none_revokes_a_previously_trusted_identity() {
    let cwd = "C:/shared/work"; let state = state(cwd);
    let epoch = state.session_manager.session_observation("pty-a").unwrap().0;
    state.session_manager.remember_agent_identity("pty-a", TrustedAgentIdentity {
        session_epoch:epoch, kind:"codex".into(), session_id:"owner-a".into(),
        agent_pid:111, agent_started_at:1791964800, from_hook:true,
    });
    let owner = state.session_manager.iter_observations().into_iter().find(|(id, _, _, _)| id == "pty-a").unwrap().2;
    let metadata = state.metadata_store.get("pty-a").unwrap().clone();
    // Clearing is required even when the display metadata did not change.
    assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,
        &state.metadata_store, &owner, None, metadata, false, |_| panic!("No display change")));
    assert!(state.session_manager.trusted_agent_identity("pty-a").is_none(), "None is a revocation, not an affirmation of A");
}


#[test]
fn fix3_r2_01_pid_birth_and_units_must_all_match_current_metadata() {
    let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
    let cwd = "C:/shared/work";
    record(&home.path().join(".codex/sessions/2026/10/14"), "owner-a", cwd, "Old A's request");
    for (pid, birth, current_pid, current_birth) in [
        (111, 1791964820, Some(222), Some(1791964820000)),
        (222, 1791964800, Some(222), Some(1791964820000)),
        (222, 1791964820000, Some(222), Some(1791964820000)),
        (222, 1791964820, None, Some(1791964820000)),
        (222, 1791964820, Some(222), None),
        (222, u64::MAX, Some(222), None),
    ] {
        let state = state(cwd);
        { let mut metadata = state.metadata_store.get_mut("pty-a").unwrap();
          metadata.agent_pid = current_pid; metadata.agent_started_at = current_birth; }
        state.session_manager.remember_agent_identity("pty-a", TrustedAgentIdentity {
            session_epoch:state.session_manager.session_observation("pty-a").unwrap().0,
            kind:"codex".into(), session_id:"owner-a".into(), agent_pid:pid, agent_started_at:birth, from_hook:true,
        });
        let mut request = request(cwd); observe_request(&mut request, &state);
        let material = fallback(request, Instant::now() + Duration::from_secs(5));
        assert!(material.record_owner.is_none(), "PID/birth mismatch or absence: {pid}/{birth}/{current_pid:?}/{current_birth:?}");
        assert!(material.initial_instruction.is_none()); assert!(material.events.is_empty());
    }
}

#[test]
fn fix3_r2_01_confirmed_seconds_identity_uses_millisecond_lookup_clock() {
    let cwd = "C:/shared/work"; let state = state(cwd);
    state.session_manager.remember_agent_identity("pty-a", TrustedAgentIdentity {
        session_epoch:state.session_manager.session_observation("pty-a").unwrap().0,
        kind:"codex".into(), session_id:"owner-a".into(), agent_pid:222, agent_started_at:1791964820, from_hook:true,
    });
    let mut request = request(cwd); observe_request(&mut request, &state);
    let lookup = request.codex_lookup.unwrap();
    assert_eq!(lookup.session_id.as_deref(), Some("owner-a"));
    assert_eq!(lookup.started_at, 1791964820000);
}

#[test]
fn fix3_r2_01_retired_observer_none_does_not_revoke_successor_identity() {
    let cwd = "C:/shared/work"; let state = state(cwd);
    let retired = state.session_manager.iter_observations().into_iter().find(|(id, _, _, _)| id == "pty-a").unwrap().2;
    let old = state.metadata_store.get("pty-a").unwrap().clone();
    let _retired = state.session_manager.retire("pty-a").unwrap();
    state.session_manager.install_fixture_owner("pty-a", 0, Duration::from_secs(20), state.metadata_store.clone());
    let epoch = state.session_manager.session_observation("pty-a").unwrap().0;
    state.session_manager.remember_agent_identity("pty-a", TrustedAgentIdentity {
        session_epoch:epoch, kind:"codex".into(), session_id:"owner-b".into(),
        agent_pid:222, agent_started_at:1791964900, from_hook:true,
    });
    assert!(!crate::pty::monitor::publish_monitor_observation(&state.session_manager,
        &state.metadata_store, &retired, None, old, true, |_| panic!("Retired observer")));
    assert_eq!(state.session_manager.trusted_agent_identity("pty-a").unwrap().session_id, "owner-b");
}


#[test]
fn fix4_r3_02_same_process_recovers_a_self_hook_uuid_after_none() {
    let home = tempfile::tempdir().unwrap(); let _owned = crate::unit_test_dirs::fixture_home(&home);
    let cwd = "C:/shared/work"; let state = state(cwd);
    record(&home.path().join(".codex/sessions/2026/10/14"), "owner-a", cwd, "A's verified request");
    let owner = state.session_manager.iter_observations().into_iter().find(|(id,_,_,_)| id == "pty-a").unwrap().2;
    state.session_manager.remember_agent_identity("pty-a", TrustedAgentIdentity {
        session_epoch:owner.epoch, kind:"codex".into(), session_id:"owner-a".into(),
        agent_pid:222, agent_started_at:1791964820, from_hook:true,
    });
    let mut missing = PtyMetadata::unobserved("pty-a".into());
    missing.session_epoch = owner.epoch; missing.cwd = cwd.into();
    assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,
        &state.metadata_store, &owner, None, missing, true, |_| {}));
    assert!(state.session_manager.trusted_agent_identity("pty-a").is_none());
    let mut gap_request = request(cwd); observe_request(&mut gap_request, &state);
    let gap = fallback(gap_request, Instant::now()+Duration::from_secs(5));
    assert!(gap.record_owner.is_none(), "Suspended evidence cannot name a tab");
    let mut recovered = PtyMetadata::unobserved("pty-a".into());
    recovered.session_epoch=owner.epoch; recovered.cwd=cwd.into();
    recovered.agent_kind=Some("codex".into()); recovered.live_agent_kind=Some("codex".into());
    recovered.agent_pid=Some(222); recovered.agent_started_at=Some(1791964820000);
    recovered.agent_session_id=Some("owner-a".into());
    // No argv/requested UUID and no new hook: the same process must re-prove the old claim.
    assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,
        &state.metadata_store, &owner, None, recovered, true, |_| {}));
    let mut recovered_request = request(cwd); observe_request(&mut recovered_request, &state);
    let material = fallback(recovered_request, Instant::now()+Duration::from_secs(5));
    assert_eq!(material.record_owner.as_deref(), Some("owner-a"));
    assert_eq!(material.initial_instruction.as_deref(), Some("A's verified request"));
    assert!(state.metadata_store.get("pty-a").unwrap().agent_session_trusted);
    assert!(serde_json::to_value(state.metadata_store.get("pty-a").unwrap().value()).unwrap().get("agent_pid").is_none());
}

#[test]
fn fix4_r3_02_replaced_process_cannot_recover_suspended_uuid() {
    for (pid,birth) in [(333,1791964820000),(222,1791964900000)] {
        let cwd="C:/shared/work"; let state=state(cwd);
        let owner=state.session_manager.iter_observations().into_iter().find(|(id,_,_,_)| id=="pty-a").unwrap().2;
        state.session_manager.remember_agent_identity("pty-a", TrustedAgentIdentity {
            session_epoch:owner.epoch,kind:"codex".into(),session_id:"owner-a".into(),
            agent_pid:222,agent_started_at:1791964820,from_hook:true,
        });
        let mut missing=PtyMetadata::unobserved("pty-a".into()); missing.session_epoch=owner.epoch;
        assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,&state.metadata_store,&owner,None,missing,true, |_| {}));
        let mut replacement=state.metadata_store.get("pty-a").unwrap().clone();
        replacement.cwd=cwd.into(); replacement.agent_kind=Some("codex".into()); replacement.live_agent_kind=Some("codex".into());
        replacement.agent_pid=Some(pid); replacement.agent_started_at=Some(birth);
        assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,&state.metadata_store,&owner,None,replacement.clone(),true, |_| {}));
        assert!(state.session_manager.trusted_agent_identity("pty-a").is_none());
        replacement.agent_pid=Some(222); replacement.agent_started_at=Some(1791964820000);
        assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,&state.metadata_store,&owner,None,replacement,true, |_| {}));
        assert!(state.session_manager.trusted_agent_identity("pty-a").is_none(), "A definite replacement discards the evidence");
    }
}


#[test]
fn fix4_r3_02_new_same_epoch_hook_beats_old_observation() {
    for suspended in [false,true] {
        for same_uuid in [false,true] {
            for old_has_identity in [false,true] {
                let state=state("C:/shared/work");
                let owner=state.session_manager.iter_observations().into_iter().find(|(id,_,_,_)| id=="pty-a").unwrap().2;
                let old=TrustedAgentIdentity {session_epoch:owner.epoch,kind:"codex".into(),session_id:"owner-a".into(),agent_pid:222,agent_started_at:1791964820,from_hook:true};
                state.session_manager.remember_agent_identity("pty-a",old.clone());
                if suspended {
                    let mut missing=PtyMetadata::unobserved("pty-a".into()); missing.session_epoch=owner.epoch;
                    assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,&state.metadata_store,&owner,None,missing,true, |_| {}));
                }
                let snapshot=state.session_manager.agent_identity_snapshot("pty-a").unwrap();
                let current=TrustedAgentIdentity {session_id:if same_uuid {"owner-a"} else {"owner-b"}.into(),..old.clone()};
                state.session_manager.remember_agent_identity("pty-a",current.clone());
                let mut stale=PtyMetadata::unobserved("pty-a".into()); stale.session_epoch=owner.epoch;
                stale.agent_kind=Some("codex".into()); stale.live_agent_kind=Some("codex".into());
                stale.agent_pid=Some(222); stale.agent_started_at=Some(1791964820000); stale.agent_session_id=Some("owner-a".into());
                let before=serde_json::to_value(state.metadata_store.get("pty-a").unwrap().value()).unwrap();
                assert!(!crate::pty::monitor::publish_monitor_observation_checked(&state.session_manager,&state.metadata_store,&owner,&snapshot,old_has_identity.then_some(old),stale,true, |_| panic!("A stale observation must not emit")));
                assert_eq!(state.session_manager.trusted_agent_identity("pty-a").unwrap().session_id,current.session_id);
                assert_eq!(serde_json::to_value(state.metadata_store.get("pty-a").unwrap().value()).unwrap(),before);
            }
        }
    }
}

#[test]
fn fix4_r3_02_active_none_revokes_even_with_unchanged_process_fields() {
    let state=state("C:/shared/work");
    let owner=state.session_manager.iter_observations().into_iter().find(|(id,_,_,_)| id=="pty-a").unwrap().2;
    state.session_manager.remember_agent_identity("pty-a",TrustedAgentIdentity {session_epoch:owner.epoch,kind:"codex".into(),session_id:"owner-a".into(),agent_pid:222,agent_started_at:1791964820,from_hook:true});
    let metadata=state.metadata_store.get("pty-a").unwrap().clone();
    assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,&state.metadata_store,&owner,None,metadata,false, |_| panic!("No display change")));
    assert!(state.session_manager.trusted_agent_identity("pty-a").is_none());
    assert!(state.session_manager.agent_identity_snapshot("pty-a").unwrap().hook_for_process("codex",222,1791964820).is_some());
}

#[test]
fn fix4_r3_02_missing_process_fields_never_reactivate_suspended_evidence() {
    for (pid,birth) in [(None,Some(1791964820000)),(Some(222),None),(None,None),(Some(222),Some(1791964820))] {
        let state=state("C:/shared/work");
        let owner=state.session_manager.iter_observations().into_iter().find(|(id,_,_,_)| id=="pty-a").unwrap().2;
        state.session_manager.remember_agent_identity("pty-a",TrustedAgentIdentity {session_epoch:owner.epoch,kind:"codex".into(),session_id:"owner-a".into(),agent_pid:222,agent_started_at:1791964820,from_hook:true});
        let mut missing=PtyMetadata::unobserved("pty-a".into()); missing.session_epoch=owner.epoch;
        assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,&state.metadata_store,&owner,None,missing.clone(),true, |_| {}));
        missing.agent_pid=pid; missing.agent_started_at=birth; missing.live_agent_kind=Some("codex".into()); missing.agent_kind=Some("codex".into());
        assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,&state.metadata_store,&owner,None,missing,true, |_| {}));
        assert!(state.session_manager.trusted_agent_identity("pty-a").is_none());
    }
}

#[test]
fn fix4_r3_02_closed_or_new_epoch_pty_discards_suspended_evidence() {
    for close in [true,false] {
        let state=state("C:/shared/work");
        let owner=state.session_manager.iter_observations().into_iter().find(|(id,_,_,_)| id=="pty-a").unwrap().2;
        state.session_manager.remember_agent_identity("pty-a",TrustedAgentIdentity {session_epoch:owner.epoch,kind:"codex".into(),session_id:"owner-a".into(),agent_pid:222,agent_started_at:1791964820,from_hook:true});
        let mut missing=PtyMetadata::unobserved("pty-a".into()); missing.session_epoch=owner.epoch;
        assert!(crate::pty::monitor::publish_monitor_observation(&state.session_manager,&state.metadata_store,&owner,None,missing,true, |_| {}));
        let snapshot=state.session_manager.agent_identity_snapshot("pty-a").unwrap();
        if close { let _retired=state.session_manager.retire("pty-a").unwrap(); assert!(state.session_manager.agent_identity_snapshot("pty-a").is_none()); }
        state.session_manager.install_fixture_owner("pty-a",0,Duration::from_secs(20),state.metadata_store.clone());
        let current=state.session_manager.agent_identity_snapshot("pty-a").unwrap();
        assert!(current.hook_for_process("codex",222,1791964820).is_none());
        let mut metadata=PtyMetadata::unobserved("pty-a".into()); metadata.session_epoch=state.session_manager.session_observation("pty-a").unwrap().0;
        metadata.agent_pid=Some(222); metadata.agent_started_at=Some(1791964820000); metadata.agent_kind=Some("codex".into()); metadata.live_agent_kind=Some("codex".into());
        assert!(!crate::pty::monitor::publish_monitor_observation_checked(&state.session_manager,&state.metadata_store,&owner,&snapshot,None,metadata.clone(),true, |_| panic!("Old epoch")));
        let owner=state.session_manager.iter_observations().into_iter().find(|(id,_,_,_)| id=="pty-a").unwrap().2;
        assert!(crate::pty::monitor::publish_monitor_observation_checked(&state.session_manager,&state.metadata_store,&owner,&current,None,metadata,true, |_| {}));
        assert!(state.session_manager.trusted_agent_identity("pty-a").is_none());
    }
}
