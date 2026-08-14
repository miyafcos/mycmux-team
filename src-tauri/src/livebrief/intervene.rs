use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};

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
    if let Some(reason) = prove_current_agent_ownership(service, &brief) {
        return Ok(InterventionResult::RejectedBeforeWrite { reason });
    }
    let payload = match resolve_payload(&brief, &action) { Ok(payload) => payload, Err(reason) => return Ok(InterventionResult::RejectedBeforeWrite { reason }) };
    let audit = AuditRecord::prepared(&expectation, &action, &payload);
    if append_audit(&audit, "prepared").is_err() { return Ok(InterventionResult::RejectedBeforeWrite { reason: "audit_prepare_failed".to_string() }); }
    coordinator.in_flight_prompt = Some((expectation.prompt_event_id.clone(), expectation.source_revision));
    let mut frame = payload.into_bytes();
    frame.push(b'\r');
    let receiver = match service.manager().write_intervention_if_revision(&expectation.pty_session_id, expectation.pty_input_revision, &frame) {
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
    let mut system = System::new_all();
    system.refresh_all();
    let mut descendant_found = false;
    for process in system.processes().values() {
        if process.name().to_string_lossy().to_ascii_lowercase().contains(&brief.binding.agent_kind) && is_descendant(process.pid(), Pid::from_u32(root_pid), &system) { descendant_found = true; break; }
    }
    if !descendant_found { return Some("foreground_agent_ownership".to_string()); }
    let metadata = service.metadata().get(&brief.binding.pty_session_id)?;
    if metadata.agent_kind.as_deref() != Some(brief.binding.agent_kind.as_str()) || metadata.agent_session_id.as_deref() != Some(brief.binding.agent_session_id.as_str()) { return Some("agent_mapping".to_string()); }
    None
}

fn is_descendant(mut child: Pid, root: Pid, system: &System) -> bool {
    while let Some(process) = system.process(child) {
        if child == root { return true; }
        let Some(parent) = process.parent() else { return false; };
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
mod tests {
    use super::*;
    #[test]
    fn reply_rejects_every_control_character() { for bad in ["x\n", "x\r", "x\0", "x\u{1b}", "x\u{3}", "x\u{7f}", "x\u{80}"] { assert!(validate_reply_text(bad).is_err(), "{bad:?}"); } }
    #[test]
    fn reply_accepts_one_logical_line() { assert!(validate_reply_text("日本語の回答").is_ok()); }
}
