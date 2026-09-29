//! Test support for the hook -> monitor -> transcript regression in monitor/tests.rs.
use super::*;

pub(crate) fn assert_hook_rebind(kind: &str, pty: &str, update: impl FnOnce() -> AgentSessionMapping) {
    let dir = tempfile::tempdir().unwrap();
    let old_path = dir.path().join("old.jsonl");
    let new_path = dir.path().join("new.jsonl");
    let line = |text| if kind == "codex" {
        serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":text}}).to_string() + "\n"
    } else {
        serde_json::json!({"type":"user","message":{"role":"user","content":text}}).to_string() + "\n"
    };
    std::fs::write(&old_path, line("old instruction")).unwrap();
    std::fs::write(&new_path, line("new instruction")).unwrap();
    let binding = LiveBinding {
        pty_session_id: pty.into(), agent_session_id: "old-session".into(), agent_kind: kind.into(),
        pty_instance_id: "instance".into(), pty_generation: 1, source_revision: 0, pty_input_revision: 0,
    };
    let prior = bootstrap_transcript(&old_path, kind, &binding, "epoch").unwrap();
    let mapping = update();
    assert_eq!(mapping.session_id, "new-session");
    assert_eq!(mapping.agent_kind.as_deref(), Some(kind));
    let next_binding = LiveBinding { agent_session_id: mapping.session_id, ..binding };
    assert!(matches!(transcript_path_decision(Some(&prior), &next_binding), TranscriptPathDecision::NeedsDiscovery));
    for delayed in [false, true] {
        let unavailable = delayed.then(|| refresh_bound_transcript(
            Some(&prior), &next_binding, kind, "new-session", "epoch", None, None, |_, _| None,
        ).unwrap());
        let snapshot = refresh_bound_transcript(
            unavailable.as_ref().or(Some(&prior)), &next_binding, kind, "new-session", "epoch", None, None,
            |found_kind, id| {
                assert_eq!(found_kind, kind);
                assert_eq!(id, "new-session");
                Some(new_path.clone())
            },
        ).unwrap();
        assert_eq!(snapshot.cursor.path, new_path);
        assert_eq!(snapshot.brief.latest_instruction.as_deref(), Some("new instruction"));
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.brief.telemetry_health, "live");
        assert!(refresh_bound_transcript(Some(&snapshot), &next_binding, kind, "new-session", "epoch", None, None,
            |_, _| panic!("second settled tick must reuse the new transcript")).is_none());
    }
}
