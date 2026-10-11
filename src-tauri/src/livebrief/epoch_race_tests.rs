use super::*;
use crate::pty::manager::TrustedAgentIdentity;
use crate::pty::monitor::{publish_monitor_observation, PtyMetadata};
use std::time::Duration;

#[test]
fn integ5_held_e1_monitor_and_snapshot_cannot_supply_e2_process_evidence() {
    for successor_observed_first in [false, true] {
        let p = format!("integ5-race-{successor_observed_first}");
        let c = uuid::Uuid::new_v4().to_string();
        let manager = Arc::new(SessionManager::new());
        let store = crate::pty::monitor::new_metadata_store();
        let service = LiveBriefService::new(manager.clone(), store.clone());
        manager.install_fixture_owner(&p, 11, Duration::from_secs(60), store.clone());
        let e1 = manager.session_observation(&p).unwrap().0;
        let owner1 = manager.get(&p).unwrap().observation_owner();
        let birth = (unix_ms() - 60_000) as u64 / 1000;
        let identity = |pid, started_at, session_epoch| TrustedAgentIdentity {
            session_epoch,
            kind: "codex".into(), session_id: c.clone(), agent_pid: pid,
            agent_started_at: started_at, from_hook: false,
        };
        let mut old = PtyMetadata::unobserved(p.clone());
        old.session_epoch = e1;
        old.live_agent_kind = Some("codex".into()); old.agent_kind = Some("codex".into());
        old.agent_session_id = Some(c.clone()); old.agent_started_at = Some(birth * 1000);
        old.observed_at = Some((unix_ms() + 10_000) as u64); // Fresh wall time cannot prove ownership.
        old.process_name = Some("codex".into()); old.agent_active = true;
        publish_monitor_observation(&manager, &store, &owner1, Some(identity(11, birth, e1)), old.clone(), true, |_| {});
        let held_query = crate::commands::terminal::metadata_snapshot_for(&manager, &store);
        let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir); let path = dir.path().join("rollout.jsonl");
        let stamp = |value: serde_json::Value, id: &str| {
            let mut value = value;
            value["timestamp"] = serde_json::json!(chrono::DateTime::from_timestamp_millis(unix_ms() - 30_000).unwrap().to_rfc3339());
            value["uuid"] = serde_json::json!(id); value.to_string() + "\n"
        };
        std::fs::write(&path,
            stamp(serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"old"}}), "start")
            + &stamp(serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"old-tool","name":"Bash","arguments":"{}"}}), "tool")
            + &stamp(serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"old-question","name":"request_user_input","arguments":"{\"question\":\"Old question?\",\"options\":[\"yes\",\"no\"]}"}}), "question")
        ).unwrap();
        missing_transcripts().lock().unwrap().paths.insert(("codex".into(), c.clone()), (path.clone(), Instant::now()));
        let mappings = HashMap::from([(p.clone(), AgentSessionMapping { agent_kind: Some("codex".into()), session_id: c.clone(), hook_confirmed: false })]);
        let prior = service.refresh_one(&p, mappings.get(&p), &mappings, None).unwrap();
        assert_eq!(prior.brief.autonomy.as_ref().unwrap().open_tool_count, 2);
        assert!(prior.brief.prompt_event_id.is_some(), "fixture must have an actionable E1 question");
        let source_before = std::fs::read(&path).unwrap();
        let retired = manager.retire(&p).unwrap(); // Keep E1 physical object alive through the race.
        assert!(manager.session_age(&p).is_none());
        assert!(!store.contains_key(&p), "retirement invalidates the old metadata entry");
        manager.install_fixture_owner(&p, 22, Duration::ZERO, store.clone());
        let e2 = manager.session_observation(&p).unwrap().0;
        assert_ne!(e1, e2);
        assert!(manager.session_age(&p).unwrap() < Duration::from_secs(1));
        if successor_observed_first {
            let owner2 = manager.get(&p).unwrap().observation_owner();
            let mut new = old.clone(); new.session_epoch = e2; new.agent_started_at = Some((unix_ms() / 1000 + 1) as u64 * 1000);
            publish_monitor_observation(&manager, &store, &owner2, Some(identity(22, (unix_ms() / 1000 + 1) as u64, e2)), new, true, |_| {});
        }
        // Release E1 only after the manager owns E2, optionally after E2's monitor observation.
        publish_monitor_observation(&manager, &store, &owner1, Some(identity(11, birth, e1)), old.clone(), true, |_| {});
        let current_query = crate::commands::terminal::metadata_snapshot_for(&manager, &store);
        let current_identity = manager.trusted_agent_identity(&p);
        assert_ne!(current_identity.as_ref().map(|value| value.agent_pid), Some(11), "delayed E1 identity was admitted for E2");
        assert_ne!(current_query[&p].agent_started_at, held_query[&p].agent_started_at, "retired metadata supplied the successor birth");
        let next = service.refresh_one(&p, mappings.get(&p), &mappings, Some(&prior)).unwrap();
        assert_eq!(next.brief.binding.pty_generation, e2);
        assert_eq!(next.brief.autonomy.as_ref().unwrap().open_tool_count, 0);
        assert!(next.brief.pending_prompt.is_none() && next.brief.prompt_event_id.is_none() && next.brief.prompt_hash.is_none());
        crate::livebrief::intervene::assert_retired_prompt_rejected(&prior.brief, &next.brief);
        assert!(manager.is_running(&p), "old exit must not kill the successor");
        assert!(manager.write_intervention_if_revision(&p, Some(e1), 0, b"old reply").unwrap_err().starts_with("PTY_SESSION_EPOCH_CONFLICT"));
        assert_eq!(std::fs::read(&path).unwrap(), source_before, "E2 produced no new transcript output");
        drop(retired);
    }
}
