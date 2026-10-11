use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use super::adapter::normalize;
use super::{sha256_hex, unix_ms, LiveBriefService, LiveSessionBrief};

const MAX_REPLY_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InterventionExpectation {
    pub intervention_id: String,
    pub pty_session_id: String,
    pub agent_session_id: String,
    pub pty_instance_id: String,
    pub pty_generation: u64,
    pub source_revision: u64,
    pub pty_input_revision: u64,
    pub prompt_event_id: String,
    pub prompt_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InterventionAction { ReplyText { text: String }, Choose { option_id: String } }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InterventionResult {
    Conflict { reason: String, latest_brief: Option<LiveSessionBrief> },
    Busy,
    RejectedBeforeWrite { reason: String },
    WrittenAwaitingEvidence,
    Confirmed { matched_event_id: String },
    WrittenUnconfirmed,
    IndeterminatePartial,
}

#[derive(Default)]
pub(crate) struct Coordinator {
    outcomes: HashMap<String, InterventionResult>,
    in_flight_prompt: Option<(String, u64)>,
}

pub(crate) fn send(service: &LiveBriefService, expectation: InterventionExpectation, action: InterventionAction) -> Result<InterventionResult, String> {
    let coordinator = service.coordinator(&expectation.pty_session_id);
    let mut coordinator = coordinator.lock().map_err(|_| "live intervention coordinator is poisoned".to_string())?;
    if let Some(outcome) = coordinator.outcomes.get(&expectation.intervention_id) { return Ok(outcome.clone()); }
    service.snapshots(); // synchronous EOF catch-up before inspecting the expectation
    let Some(snapshot) = service.current(&expectation.pty_session_id) else { return Ok(InterventionResult::Conflict { reason: "target_missing".to_string(), latest_brief: None }); };
    let brief = snapshot.brief.clone();
    if let Some((prompt_event_id, source_revision)) = &coordinator.in_flight_prompt {
        if *prompt_event_id == expectation.prompt_event_id && *source_revision == expectation.source_revision { return Ok(InterventionResult::Busy); }
    }
    if let Some(reason) = expectation_conflict(&brief, &expectation) {
        return Ok(InterventionResult::Conflict { reason, latest_brief: Some(brief) });
    }
    let identity = service.manager().trusted_agent_identity(&brief.binding.pty_session_id);
    if let Some(reason) = process_identity_conflict(&snapshot, identity.as_ref()) {
        return Ok(InterventionResult::RejectedBeforeWrite { reason });
    }
    if let Some(reason) = prove_current_agent_ownership(service, &brief) {
        return Ok(InterventionResult::RejectedBeforeWrite { reason });
    }
    let payload = match resolve_payload(&brief, &action) { Ok(payload) => payload, Err(reason) => return Ok(InterventionResult::RejectedBeforeWrite { reason }) };
    let audit = AuditRecord::prepared(&expectation, &action, &payload);
    if append_audit(&audit, "prepared").is_err() { return Ok(InterventionResult::RejectedBeforeWrite { reason: "audit_prepare_failed".to_string() }); }
    coordinator.in_flight_prompt = Some((expectation.prompt_event_id.clone(), expectation.source_revision));
    let mut frame = payload.into_bytes();
    frame.push(b'\r');
    let receiver = match service.manager().write_intervention_if_revision(&expectation.pty_session_id, Some(brief.binding.pty_generation), expectation.pty_input_revision, &frame) {
        Ok(receiver) => receiver,
        Err(error) if error.starts_with("PTY_INPUT_REVISION_CONFLICT") => {
            coordinator.in_flight_prompt = None;
            return Ok(InterventionResult::Conflict { reason: "pty_input_revision".to_string(), latest_brief: service.current(&expectation.pty_session_id).map(|snapshot| snapshot.brief) });
        }
        Err(error) => { coordinator.in_flight_prompt = None; return Ok(InterventionResult::RejectedBeforeWrite { reason: error }); }
    };
    let _ = append_audit(&audit, "enqueued");
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => { let _ = append_audit(&audit, "written"); }
        Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => {
            coordinator.in_flight_prompt = None;
            let outcome = InterventionResult::IndeterminatePartial;
            coordinator.outcomes.insert(expectation.intervention_id.clone(), outcome.clone());
            let _ = append_audit(&audit, "indeterminate");
            return Ok(outcome);
        }
        Err(RecvTimeoutError::Timeout) => {
            let outcome = InterventionResult::WrittenAwaitingEvidence;
            coordinator.outcomes.insert(expectation.intervention_id.clone(), outcome.clone());
            let _ = append_audit(&audit, "awaiting_evidence");
            return Ok(outcome);
        }
    }
    // Do not hold an assumption that a source revision advance is confirmation.
    // A later UI refresh may present the updated question, but never auto-resends.
    let outcome = InterventionResult::WrittenUnconfirmed;
    coordinator.outcomes.insert(expectation.intervention_id.clone(), outcome.clone());
    let _ = append_audit(&audit, "timeout");
    coordinator.in_flight_prompt = None;
    Ok(outcome)
}

// A throttled refresh can leave the old brief cached after the monitor has
// already observed a new process. Reject that ownership mismatch before writes.
fn process_identity_conflict(
    snapshot: &super::SessionSnapshot, identity: Option<&crate::pty::manager::TrustedAgentIdentity>,
) -> Option<String> {
    let current = identity.filter(|identity| identity.kind == snapshot.brief.binding.agent_kind
        && identity.session_id == snapshot.brief.binding.agent_session_id && identity.agent_started_at > 0)
        .map(super::AgentProcessIdentity::from);
    snapshot.agent_process.zip(current).filter(|(old, new)| old != new).map(|_| "agent_process".to_string())
}

fn expectation_conflict(brief: &LiveSessionBrief, expected: &InterventionExpectation) -> Option<String> {
    let binding = &brief.binding;
    if brief.telemetry_health != "live" { return Some("telemetry_health".to_string()); }
    if brief.operational_state != "needsHuman" { return Some("operational_state".to_string()); }
    if binding.pty_session_id != expected.pty_session_id || binding.agent_session_id != expected.agent_session_id || binding.pty_instance_id != expected.pty_instance_id || binding.pty_generation != expected.pty_generation { return Some("binding".to_string()); }
    if binding.source_revision != expected.source_revision || binding.pty_input_revision != expected.pty_input_revision { return Some("revision".to_string()); }
    if brief.prompt_event_id.as_deref() != Some(expected.prompt_event_id.as_str()) || brief.prompt_hash.as_deref() != Some(expected.prompt_hash.as_str()) { return Some("prompt".to_string()); }
    None
}

fn resolve_payload(brief: &LiveSessionBrief, action: &InterventionAction) -> Result<String, String> {
    match action {
        InterventionAction::ReplyText { text } => { validate_reply_text(text)?; Ok(text.clone()) }
        InterventionAction::Choose { option_id } => {
            let option = brief.pending_options.iter().find(|option| option.id == *option_id).ok_or_else(|| "option_id".to_string())?;
            if option.payload.is_empty() { return Err("option_payload_missing".to_string()); }
            Ok(option.payload.clone())
        }
    }
}

fn validate_reply_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() { return Err("empty_reply".to_string()); }
    if text.len() > MAX_REPLY_BYTES { return Err("reply_too_large".to_string()); }
    if text.chars().any(|character| character == '\r' || character == '\n' || character == '\0' || character == '\u{1b}' || character == '\u{3}' || character == '\u{7f}' || character <= '\u{1f}' || ('\u{80}'..='\u{9f}').contains(&character)) { return Err("reply_contains_control_character".to_string()); }
    Ok(())
}

fn prove_current_agent_ownership(service: &LiveBriefService, brief: &LiveSessionBrief) -> Option<String> {
    let (_, _, root_pid) = service.manager().intervention_observation(&brief.binding.pty_session_id)?;
    let root_pid = root_pid?;
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut descendant_found = false;
    for process in system.processes().values() {
        if process.name().to_string_lossy().to_ascii_lowercase().contains(&brief.binding.agent_kind) && is_descendant(process.pid(), Pid::from_u32(root_pid), &system) { descendant_found = true; break; }
    }
    if !descendant_found { return Some("foreground_agent_ownership".to_string()); }
    let metadata = service.metadata().get(&brief.binding.pty_session_id)?;
    if metadata.agent_kind.as_deref() != Some(brief.binding.agent_kind.as_str()) || metadata.agent_session_id.as_deref() != Some(brief.binding.agent_session_id.as_str()) { return Some("agent_mapping".to_string()); }
    None
}

fn is_descendant(child: Pid, root: Pid, system: &System) -> bool {
    is_descendant_with(child, root, |pid| {
        system.process(pid).map(|process| (process.parent(), process.start_time()))
    })
}

pub(crate) fn is_descendant_with(mut child: Pid, root: Pid, mut lookup: impl FnMut(Pid) -> Option<(Option<Pid>, u64)>) -> bool {
    let mut visited = HashSet::new();
    for _ in 0..64 {
        if !visited.insert(child) { return false; }
        let Some((parent, child_started)) = lookup(child) else { return false; };
        if child == root { return true; }
        let Some(parent) = parent else { return false; };
        let Some((_, parent_started)) = lookup(parent) else { return false; };
        // A newer parent is a recycled PID, not evidence of ownership.
        if parent_started > child_started { return false; }
        child = parent;
    }
    false
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditRecord<'a> { ts: i64, intervention_id: &'a str, pty_session_id: &'a str, action: &'a str, utf8_bytes: usize, sha256: String, stage: &'a str }
impl<'a> AuditRecord<'a> {
    fn prepared(expectation: &'a InterventionExpectation, action: &'a InterventionAction, payload: &str) -> Self { Self { ts: unix_ms(), intervention_id: &expectation.intervention_id, pty_session_id: &expectation.pty_session_id, action: match action { InterventionAction::ReplyText { .. } => "replyText", InterventionAction::Choose { .. } => "choose" }, utf8_bytes: payload.len(), sha256: sha256_hex(normalize(payload).as_bytes()), stage: "prepared" } }
}
fn append_audit(record: &AuditRecord<'_>, stage: &str) -> Result<(), String> {
    let dir = crate::test_profile::runtime_dir()?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("create audit directory: {error}"))?;
    let line = serde_json::to_string(&AuditRecord { ts: record.ts, intervention_id: record.intervention_id, pty_session_id: record.pty_session_id, action: record.action, utf8_bytes: record.utf8_bytes, sha256: record.sha256.clone(), stage }).map_err(|error| format!("serialize audit: {error}"))?;
    let path = dir.join("intervention-log.jsonl");
    let mut file = OpenOptions::new().create(true).append(true).open(path).map_err(|error| format!("open audit: {error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("write audit: {error}"))?; file.sync_data().map_err(|error| format!("flush audit: {error}"))
}


#[cfg(test)]
mod cancelled_question_tests {
    use super::*;
    use crate::livebrief::{adapter::AgentAdapter, reducer::LiveBriefReducer, ByteRange, LiveBinding};
    use serde_json::{json,Value};

    fn replay(adapter:&mut AgentAdapter,reducer:&mut LiveBriefReducer,row:Value,seq:u64) {
        let raw=serde_json::to_string(&row).unwrap();
        for event in adapter.decode_record(&raw,ByteRange {start:seq*100,end:seq*100+99},seq).unwrap() { reducer.apply(&event); }
    }
    #[test]
    fn g1_restarted_questions_are_retired_by_the_service_and_fail_the_actual_intervention_gate() {
        use crate::livebrief::{bootstrap_transcript, refresh_autonomy, advance_transcript_with_history};
        for (provider, tool) in [("codex","request_user_input"),("codex","request_permissions"),("claude","AskUserQuestion")] {
            let dir=tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir); let path=dir.path().join("restart.jsonl");
            let at=crate::livebrief::adapter::parse_timestamp("2026-10-08T05:20:00Z").unwrap();
            let stamp=|mut row:Value,time:i64,id:&str| {
                row["timestamp"]=json!(chrono::DateTime::from_timestamp_millis(time).unwrap().to_rfc3339());
                row["uuid"]=json!(id); row.to_string()+"\n"
            };
            let start=|id:&str| if provider=="codex" {json!({"type":"event_msg","payload":{"type":"task_started","turn_id":id}})}
                else {json!({"type":"user","message":{"content":id}})};
            let question=|id:&str| {
                let input=json!({"question":id,"options":["yes","no"]});
                if provider=="codex" {json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"name":tool,"arguments":input.to_string()}})}
                else {json!({"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":id,"name":tool,"input":input}]}})}
            };
            let complete=if provider=="codex" {json!({"type":"event_msg","payload":{"type":"task_complete"}})}
                else {json!({"type":"assistant","message":{"stop_reason":"end_turn","content":[]}})};
            let old_rows=stamp(start("old"),at,"old-start")+&stamp(question("old-question"),at+1000,"old-question");
            std::fs::write(&path,&old_rows).unwrap();
            let binding=LiveBinding {pty_session_id:"pty".into(),agent_session_id:"agent".into(),agent_kind:provider.into(),
                pty_instance_id:"instance".into(),pty_generation:1,source_revision:0,pty_input_revision:1};
            let prior=bootstrap_transcript(&path,provider,&binding,"test").unwrap();
            assert!(dir.path().join(".mycmux/history.db").is_file(), "history must be in this explicit fixture");
            let expectation=|brief:&LiveSessionBrief,prompt:&LiveSessionBrief| InterventionExpectation {
                intervention_id:"reply".into(),pty_session_id:brief.binding.pty_session_id.clone(),
                agent_session_id:brief.binding.agent_session_id.clone(),pty_instance_id:brief.binding.pty_instance_id.clone(),
                pty_generation:brief.binding.pty_generation,source_revision:brief.binding.source_revision,pty_input_revision:brief.binding.pty_input_revision,
                prompt_event_id:prompt.prompt_event_id.clone().unwrap(),prompt_hash:prompt.prompt_hash.clone().unwrap(),
            };
            assert_eq!(expectation_conflict(&prior.brief,&expectation(&prior.brief,&prior.brief)),None);
            let birth=at+1500;
            let cleared=refresh_autonomy(None,Some(&prior),birth,Some(birth)).unwrap();
            assert_ne!(cleared.brief.operational_state,"needsHuman");
            assert!(cleared.brief.pending_input_kind.is_none() && cleared.brief.prompt_hash.is_none() && cleared.brief.prompt_event_id.is_none());
            assert!(cleared.brief.pending_options.is_empty());
            assert_eq!(expectation_conflict(&cleared.brief,&expectation(&prior.brief,&prior.brief)),Some("operational_state".into()));
            assert_eq!(expectation_conflict(&cleared.brief,&expectation(&cleared.brief,&prior.brief)),Some("operational_state".into()));
            let next_rows=old_rows.clone()+&stamp(start("new"),at+2000,"new-start")+&stamp(complete,at+3000,"new-complete");
            std::fs::write(&path,&next_rows).unwrap();
            let next=advance_transcript_with_history(cleared,&std::fs::metadata(&path).unwrap(),&binding,"test",None,None).unwrap();
            let completed=refresh_autonomy(Some(next),Some(&prior),at+4000,Some(birth)).unwrap();
            assert!(completed.brief.prompt_hash.is_none());
            assert_eq!(expectation_conflict(&completed.brief,&expectation(&completed.brief,&prior.brief)),Some("operational_state".into()));
            // Confirmation arrives after a current-process question was parsed:
            // retiring the old question must leave the current one intact.
            std::fs::write(&path,next_rows+&stamp(question("current-question"),at+5000,"current-question")).unwrap();
            let late=advance_transcript_with_history(prior.clone(),&std::fs::metadata(&path).unwrap(),&binding,"test",None,None).unwrap();
            let current=refresh_autonomy(Some(late),Some(&prior),at+6000,Some(birth)).unwrap();
            assert_eq!(current.brief.operational_state,"needsHuman");
            assert_eq!(expectation_conflict(&current.brief,&expectation(&current.brief,&current.brief)),None);
            let mut adapter=current.adapter.clone();
            assert!(adapter.retire_prior_process(Some(birth)).is_empty());
        }
    }

    #[test]
    fn f1_aborted_questions_fail_the_actual_intervention_expectation_gate() {
        for (provider,tool) in [("codex","request_user_input"),("codex","request_permissions"),("claude","AskUserQuestion")] {
            let mut adapter=AgentAdapter::new(provider).unwrap(); let mut reducer=LiveBriefReducer::new();
            let input=json!({"question":"Continue?","options":["yes","no"]});
            let start=if provider=="codex" {json!({"type":"event_msg","payload":{"type":"task_started"}})}
                else {json!({"type":"user","message":{"content":"work"}})};
            replay(&mut adapter,&mut reducer,start,1);
            let question=if provider=="codex" {json!({"type":"response_item","payload":{"type":"function_call","call_id":"ask","name":tool,"arguments":input.to_string()}})}
                else {json!({"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"ask","name":tool,"input":input}]}})};
            replay(&mut adapter,&mut reducer,question,2);
            let binding=LiveBinding {pty_session_id:"pty".into(),agent_session_id:"agent".into(),agent_kind:provider.into(),pty_instance_id:"instance".into(),pty_generation:1,source_revision:2,pty_input_revision:1};
            let before=reducer.to_brief(binding.clone(),"live","test",1000);
            let expected=InterventionExpectation { intervention_id:"stale-reply".into(),pty_session_id:"pty".into(),agent_session_id:"agent".into(),pty_instance_id:"instance".into(),pty_generation:1,source_revision:2,pty_input_revision:1,prompt_event_id:before.prompt_event_id.clone().unwrap(),prompt_hash:before.prompt_hash.clone().unwrap()};
            assert_eq!(expectation_conflict(&before,&expected),None);
            let abort=if provider=="codex" {json!({"type":"event_msg","payload":{"type":"turn_aborted"}})}
                else {json!({"type":"user","message":{"content":"[Request interrupted by user]"}})};
            replay(&mut adapter,&mut reducer,abort,3);
            let after=reducer.to_brief(LiveBinding {source_revision:3,..binding},"live","test",2000);
            assert_ne!(after.operational_state,"needsHuman");
            assert!(after.pending_input_kind.is_none()); assert!(after.pending_prompt.is_none());
            assert!(after.pending_options.is_empty()); assert!(after.prompt_hash.is_none()); assert!(after.prompt_event_id.is_none());
            assert_eq!(expectation_conflict(&after,&expected),Some("operational_state".into()));
            // Even matching revisions (a newly prepared stale reply) cannot pass.
            let fresh_expected=InterventionExpectation {source_revision:3,..expected};
            assert_eq!(expectation_conflict(&after,&fresh_expected),Some("operational_state".into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ancestry(child: u32, root: u32, rows: &[(u32, Option<u32>, u64)]) -> bool {
        is_descendant_with(Pid::from_u32(child), Pid::from_u32(root), |pid| {
            rows.iter().find(|(id, _, _)| *id == pid.as_u32())
                .map(|(_, parent, start)| (parent.map(Pid::from_u32), *start))
        })
    }

    #[test]
    fn descendant_walk_returns_false_on_cycles_missing_parents_and_reused_pids() {
        let cycle = [(23112, Some(444), 1), (444, Some(56876), 1),
            (56876, Some(33636), 1), (33636, Some(23112), 1)];
        for child in [23112, 444, 56876, 33636] {
            assert!(!ancestry(child, 99, &cycle));
        }
        assert!(!ancestry(1, 99, &[(1, Some(1), 1)]));
        assert!(!ancestry(1, 99, &[(1, Some(2), 1), (2, Some(1), 1)]));
        assert!(!ancestry(3, 1, &[(3, Some(2), 1)]));
        assert!(!ancestry(3, 1, &[(3, Some(1), 1), (1, None, 2)]));
    }

    #[test]
    fn descendant_walk_accepts_normal_trees_and_bounds_the_depth() {
        let tree = [(1, None, 1), (2, Some(1), 2), (3, Some(2), 3)];
        assert!(ancestry(3, 1, &tree));
        assert!(ancestry(1, 1, &tree));
        assert!(!ancestry(2, 3, &tree));
        let chain: Vec<_> = (1..=100).map(|id| (id, (id > 1).then_some(id - 1), u64::from(id))).collect();
        assert!(ancestry(60, 1, &chain));
        assert!(!ancestry(100, 1, &chain));
    }

    #[test]
    fn reply_rejects_every_control_character() { for bad in ["x\n", "x\r", "x\0", "x\u{1b}", "x\u{3}", "x\u{7f}", "x\u{80}"] { assert!(validate_reply_text(bad).is_err(), "{bad:?}"); } }
    #[test]
    fn reply_accepts_one_logical_line() { assert!(validate_reply_text("日本語の回答").is_ok()); }
}

#[cfg(test)]
mod same_second_process_tests {
    use super::*;
    use crate::livebrief::{
        advance_transcript_with_history, bootstrap_transcript,
        bootstrap_transcript_seeded, refresh_autonomy_for_process, AgentProcessIdentity, LiveBinding,
    };
    use crate::pty::manager::TrustedAgentIdentity;
    use serde_json::{json, Value};

    #[test]
    fn j1_g1_f3_same_second_process_swap_retires_old_work_and_checks_the_actual_reply_guard() {
        let base = crate::livebrief::adapter::parse_timestamp("2026-10-08T05:20:00Z").unwrap();
        for (provider, tool) in [("codex", "request_user_input"), ("codex", "request_permissions"), ("claude", "AskUserQuestion")] {
            // A different PID in the exact same birth second is a replacement
            // too. Also cover a reused PID whose recorded birth second changes.
            for (old_birth, new_pid) in [(base - 5000, 22), (base + 1000, 22), (base - 5000, 11)] {
                let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
                let path = dir.path().join("same-second.jsonl");
                let stamp = |mut value: Value, at: i64, id: &str| {
                    value["timestamp"] = json!(chrono::DateTime::from_timestamp_millis(at).unwrap().to_rfc3339());
                    value["uuid"] = json!(id);
                    value.to_string() + "\n"
                };
                let start = |id: &str| if provider == "codex" {
                    json!({"type":"event_msg","payload":{"type":"task_started","turn_id":id}})
                } else { json!({"type":"user","message":{"content":id}}) };
                let call = |id: &str, name: &str, input: Value| if provider == "codex" {
                    json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"name":name,"arguments":input.to_string()}})
                } else {
                    json!({"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":id,"name":name,"input":input}]}})
                };
                let question = |id: &str| call(id, tool, json!({"question":id,"options":["yes","no"]}));
                let complete = if provider == "codex" {
                    json!({"type":"event_msg","payload":{"type":"task_complete"}})
                } else { json!({"type":"assistant","message":{"stop_reason":"end_turn","content":[]}}) };
                let old_rows = stamp(start("old"), base, "old-start")
                    + &stamp(call("old-tool", "Bash", json!({"command":"test"})), base + 1000, "old-tool")
                    + &stamp(question("old-question"), base + 1000, "old-question");
                std::fs::write(&path, &old_rows).unwrap();
                let binding = LiveBinding {
                    pty_session_id:"pty".into(), agent_session_id:"agent".into(), agent_kind:provider.into(),
                    pty_instance_id:"instance".into(), pty_generation:1, source_revision:0, pty_input_revision:1,
                };
                let identity = |pid, birth: i64| TrustedAgentIdentity {
                    session_epoch: 1,
                    kind: provider.into(), session_id: "agent".into(), agent_pid: pid,
                    agent_started_at: (birth / 1000) as u64, from_hook: false,
                };
                let old_identity = identity(11, old_birth);
                let old_start = (old_identity.agent_started_at as i64) * 1000;
                let prior = refresh_autonomy_for_process(
                    Some(bootstrap_transcript(&path, provider, &binding, "fix4").unwrap()),
                    None, base + 1200, Some(old_start), Some(AgentProcessIdentity::from(&old_identity)),
                ).unwrap();
                let expectation = |brief: &LiveSessionBrief, prompt: &LiveSessionBrief| InterventionExpectation {
                    intervention_id: "reply".into(), pty_session_id:brief.binding.pty_session_id.clone(),
                    agent_session_id:brief.binding.agent_session_id.clone(), pty_instance_id:brief.binding.pty_instance_id.clone(),
                    pty_generation:brief.binding.pty_generation, source_revision:brief.binding.source_revision,
                    pty_input_revision:brief.binding.pty_input_revision,
                    prompt_event_id:prompt.prompt_event_id.clone().unwrap(), prompt_hash:prompt.prompt_hash.clone().unwrap(),
                };
                assert_eq!(expectation_conflict(&prior.brief, &expectation(&prior.brief, &prior.brief)), None);
                assert_eq!(prior.brief.autonomy.as_ref().unwrap().open_tool_count, 2);
                // No exchange observed: leave same-second questions writable.
                let same = refresh_autonomy_for_process(
                    None, Some(&prior), base + 1500, Some(old_start), Some(AgentProcessIdentity::from(&old_identity)),
                ).unwrap_or_else(|| prior.clone());
                assert_eq!(same.brief.prompt_hash, prior.brief.prompt_hash);
                assert_eq!(expectation_conflict(&same.brief, &expectation(&same.brief, &prior.brief)), None);
                assert_eq!(process_identity_conflict(&same, Some(&old_identity)), None);

                // Actual birth is S+1500; sysinfo exports only S+1000.
                let new_identity = identity(new_pid, base + 1500);
                let new_start = (new_identity.agent_started_at as i64) * 1000;
                assert_eq!(new_start, base + 1000);
                // The monitor may observe this while the 500ms refresh lease
                // still retains the prior brief: that pre-write path also fails.
                assert_eq!(process_identity_conflict(&prior, Some(&new_identity)), Some("agent_process".into()));
                let cleared = refresh_autonomy_for_process(
                    None, Some(&prior), base + 1500, Some(new_start), Some(AgentProcessIdentity::from(&new_identity)),
                ).unwrap();
                assert_ne!(cleared.brief.operational_state, "needsHuman");
                assert!(cleared.brief.pending_input_kind.is_none() && cleared.brief.pending_prompt.is_none());
                assert!(cleared.brief.pending_options.is_empty() && cleared.brief.prompt_hash.is_none() && cleared.brief.prompt_event_id.is_none());
                assert_eq!(cleared.brief.autonomy.as_ref().unwrap().open_tool_count, 0);
                assert_eq!(expectation_conflict(&cleared.brief, &expectation(&cleared.brief, &prior.brief)), Some("operational_state".into()));
                let new_rows = old_rows + &stamp(start("new"), base + 2000, "new-start")
                    + &stamp(complete.clone(), base + 2500, "new-complete");
                std::fs::write(&path, &new_rows).unwrap();
                let next = advance_transcript_with_history(cleared.clone(), &std::fs::metadata(&path).unwrap(), &binding, "fix4", None, None).unwrap();
                let completed = refresh_autonomy_for_process(
                    Some(next), Some(&cleared), base + 2600, Some(new_start), Some(AgentProcessIdentity::from(&new_identity)),
                ).unwrap();
                assert_eq!(expectation_conflict(&completed.brief, &expectation(&completed.brief, &prior.brief)), Some("operational_state".into()));
                std::fs::write(&path, new_rows + &stamp(question("current-question"), base + 3000, "current-question")).unwrap();
                let next = advance_transcript_with_history(completed.clone(), &std::fs::metadata(&path).unwrap(), &binding, "fix4", None, None).unwrap();
                let current = refresh_autonomy_for_process(
                    Some(next), Some(&completed), base + 4000, Some(new_start), Some(AgentProcessIdentity::from(&new_identity)),
                ).unwrap();
                assert_eq!(current.brief.operational_state, "needsHuman");
                assert_eq!(process_identity_conflict(&current, Some(&new_identity)), None);
                assert_eq!(expectation_conflict(&current.brief, &expectation(&current.brief, &current.brief)), None);
                assert_eq!(resolve_payload(&current.brief, &InterventionAction::ReplyText { text: "yes".into() }), Ok("yes".into()));
                assert_eq!(expectation_conflict(&current.brief, &expectation(&current.brief, &prior.brief)), Some("prompt".into()));
                // Replay may rebuild semantic questions. The remembered cutoff
                // still removes the old one and retains the current question.
                let replayed = bootstrap_transcript_seeded(&path, provider, &binding, "fix4", None, None, u64::MAX, Some(&current)).unwrap();
                let replayed = refresh_autonomy_for_process(
                    Some(replayed), Some(&current), base + 5000, Some(new_start), Some(AgentProcessIdentity::from(&new_identity)),
                ).unwrap();
                assert_eq!(replayed.brief.prompt_hash, current.brief.prompt_hash);
                assert_eq!(replayed.brief.autonomy.as_ref().unwrap().open_tool_count, 1);
                assert_eq!(expectation_conflict(&replayed.brief, &expectation(&replayed.brief, &replayed.brief)), None);
            }
        }
    }
}

#[cfg(test)]
pub(super) fn assert_retired_prompt_rejected(old: &LiveSessionBrief, current: &LiveSessionBrief) {
    let expected = InterventionExpectation {
        intervention_id: "integ5-old-reply".into(), pty_session_id: current.binding.pty_session_id.clone(),
        agent_session_id: current.binding.agent_session_id.clone(), pty_instance_id: current.binding.pty_instance_id.clone(),
        pty_generation: current.binding.pty_generation, source_revision: current.binding.source_revision,
        pty_input_revision: current.binding.pty_input_revision, prompt_event_id: old.prompt_event_id.clone().unwrap(),
        prompt_hash: old.prompt_hash.clone().unwrap(),
    };
    assert!(expectation_conflict(current, &expected).is_some(), "current binding must never make E1's question writable");
}
