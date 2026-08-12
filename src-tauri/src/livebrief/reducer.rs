use serde::{Deserialize, Serialize};

use super::adapter::{SemanticEventEnvelope, SemanticEventKind, UserMessageKind};
use super::{sha256_hex, LiveBinding, LiveSessionBrief};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PendingInputKind { YesNo, Choice, Permission, FreeText, Blocker }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing)]
    pub payload: String,
}

impl PendingOption { pub fn new(id: String, label: String, payload: String) -> Self { Self { id, label, payload } } }

#[derive(Clone, Debug)]
pub struct LiveBriefReducer {
    task: Option<String>,
    latest_instruction: Option<String>,
    task_source_event_ids: Vec<String>,
    open_tools: Vec<(String, String, Option<String>, String)>,
    activity: Option<(String, String, String)>,
    checkpoint: Option<(String, Vec<String>)>,
    pending: Option<(String, String, String, PendingInputKind, Vec<PendingOption>)>,
    event_seq: u64,
    last_event_at: Option<i64>,
}

impl LiveBriefReducer {
    pub fn new() -> Self { Self { task: None, latest_instruction: None, task_source_event_ids: Vec::new(), open_tools: Vec::new(), activity: None, checkpoint: None, pending: None, event_seq: 0, last_event_at: None } }

    pub fn apply(&mut self, event: &SemanticEventEnvelope) {
        self.event_seq = self.event_seq.saturating_add(1);
        self.last_event_at = Some(event.occurred_at);
        match &event.kind {
            SemanticEventKind::UserMessage { kind, text, .. } => match kind {
                UserMessageKind::TaskStart => { self.task = Some(text.clone()); self.latest_instruction = Some(text.clone()); self.task_source_event_ids = vec![event.event_id.clone()]; }
                UserMessageKind::TaskChange | UserMessageKind::Correction => {
                    self.task = Some(match &self.task { Some(task) => format!("{task} / {text}"), None => text.clone() });
                    self.latest_instruction = Some(text.clone());
                    self.task_source_event_ids.push(event.event_id.clone());
                }
                // An answer or an acknowledgement is not a new instruction: the
                // brief must keep showing the last thing actually asked for.
                UserMessageKind::Answer | UserMessageKind::Ack => {}
            },
            SemanticEventKind::ToolStart { call_id, tool, target } => self.open_tools.push((call_id.clone(), tool.clone(), target.clone(), event.event_id.clone())),
            SemanticEventKind::ToolEnd { call_id, tool, target, ok, summary } => {
                self.open_tools.retain(|(open_id, _, _, _)| open_id != call_id);
                self.activity = Some((tool.clone(), activity_text(tool, target.as_deref()), event.event_id.clone()));
                if tool.eq_ignore_ascii_case("bash") || tool.contains("test") || tool.contains("build") {
                    self.checkpoint = Some((summary.clone().unwrap_or_else(|| if *ok { "Command completed".to_string() } else { "Command failed".to_string() }), vec![event.event_id.clone()]));
                }
            }
            SemanticEventKind::AgentMessage { text } => self.activity = Some(("agentMessage".to_string(), text.chars().take(160).collect(), event.event_id.clone())),
            SemanticEventKind::Question { prompt_event_id, provider_call_id, prompt, kind, options } => self.pending = Some((prompt_event_id.clone(), provider_call_id.clone(), prompt.clone(), kind.clone(), options.clone())),
            SemanticEventKind::QuestionResolved { prompt_event_id, .. } => if self.pending.as_ref().is_some_and(|pending| pending.0 == *prompt_event_id) { self.pending = None; },
            SemanticEventKind::TestResult { pass, fail } => self.checkpoint = Some((format!("Tests: {pass} passed, {fail} failed"), vec![event.event_id.clone()])),
            SemanticEventKind::FileChange { path, change } => self.checkpoint = Some((format!("{change}: {path}"), vec![event.event_id.clone()])),
            SemanticEventKind::Error { text, .. } => self.activity = Some(("error".to_string(), text.clone(), event.event_id.clone())),
        }
    }

    pub fn to_brief(&self, binding: LiveBinding, health: &str, service_epoch: &str, now: i64) -> LiveSessionBrief {
        let activity = self.open_tools.last().map(|(_, tool, target, id)| (tool.clone(), activity_text(tool, target.as_deref()), id.clone())).or_else(|| self.activity.clone());
        let pending = self.pending.clone();
        let prompt_hash = pending.as_ref().map(|(id, _, prompt, kind, options)| {
            let values = options.iter().map(|option| format!("{}:{}", option.id, option.label)).collect::<Vec<_>>().join("|");
            sha256_hex(format!("{id}|{prompt}|{kind:?}|{values}").as_bytes())
        });
        LiveSessionBrief {
            binding, task: self.task.clone(), latest_instruction: self.latest_instruction.clone(), task_source_event_ids: self.task_source_event_ids.clone(),
            activity_kind: activity.as_ref().map(|activity| activity.0.clone()), activity_text: activity.as_ref().map(|activity| activity.1.clone()), activity_source_event_id: activity.as_ref().map(|activity| activity.2.clone()),
            checkpoint: self.checkpoint.as_ref().map(|checkpoint| checkpoint.0.clone()), checkpoint_evidence_event_ids: self.checkpoint.as_ref().map(|checkpoint| checkpoint.1.clone()).unwrap_or_default(),
            pending_input_kind: pending.as_ref().map(|pending| pending.3.clone()), pending_prompt: pending.as_ref().map(|pending| pending.2.clone()), pending_options: pending.as_ref().map(|pending| pending.4.clone()).unwrap_or_default(),
            prompt_event_id: pending.as_ref().map(|pending| pending.0.clone()), prompt_hash,
            event_seq: self.event_seq, operational_state: if pending.is_some() { "needsHuman".to_string() } else if activity.is_some() { "running".to_string() } else { "ready".to_string() }, telemetry_health: health.to_string(),
            last_event_at: self.last_event_at, last_successful_read_at: Some(now), updated_at: now, service_epoch: service_epoch.to_string(), brief_revision: 0,
        }
    }
}

fn activity_text(tool: &str, target: Option<&str>) -> String {
    let verb = match tool.to_ascii_lowercase().as_str() { "read" => "Inspecting", "edit" | "apply_patch" => "Updating", "search" | "rg" => "Searching", "bash" | "shell_command" => "Running", _ => "Using" };
    target.filter(|target| !target.is_empty()).map(|target| format!("{verb} {target}")).unwrap_or_else(|| format!("{verb} {tool}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::livebrief::adapter::SemanticEventEnvelope;
    fn event(id: &str, kind: SemanticEventKind) -> SemanticEventEnvelope { SemanticEventEnvelope { event_id: id.to_string(), source_revision: 1, occurred_at: 1, source_byte_start: 0, source_byte_end: 1, kind } }
    #[test]
    fn task_folds_change_but_not_answer() {
        let mut reducer = LiveBriefReducer::new();
        reducer.apply(&event("a", SemanticEventKind::UserMessage { kind: UserMessageKind::TaskStart, text: "Initial".to_string(), digest: String::new() }));
        reducer.apply(&event("b", SemanticEventKind::UserMessage { kind: UserMessageKind::TaskChange, text: "Change".to_string(), digest: String::new() }));
        reducer.apply(&event("c", SemanticEventKind::UserMessage { kind: UserMessageKind::Answer, text: "yes".to_string(), digest: String::new() }));
        assert_eq!(reducer.task.as_deref(), Some("Initial / Change"));
    }
    #[test]
    fn latest_instruction_follows_task_changes_but_not_replies() {
        let mut reducer = LiveBriefReducer::new();
        reducer.apply(&event("a", SemanticEventKind::UserMessage { kind: UserMessageKind::TaskStart, text: "Initial".to_string(), digest: String::new() }));
        assert_eq!(reducer.latest_instruction.as_deref(), Some("Initial"));
        reducer.apply(&event("b", SemanticEventKind::UserMessage { kind: UserMessageKind::TaskChange, text: "Change".to_string(), digest: String::new() }));
        assert_eq!(reducer.latest_instruction.as_deref(), Some("Change"));
        reducer.apply(&event("c", SemanticEventKind::UserMessage { kind: UserMessageKind::Answer, text: "yes".to_string(), digest: String::new() }));
        reducer.apply(&event("d", SemanticEventKind::UserMessage { kind: UserMessageKind::Ack, text: "ok".to_string(), digest: String::new() }));
        assert_eq!(reducer.latest_instruction.as_deref(), Some("Change"));
        reducer.apply(&event("e", SemanticEventKind::UserMessage { kind: UserMessageKind::Correction, text: "違う".to_string(), digest: String::new() }));
        assert_eq!(reducer.latest_instruction.as_deref(), Some("違う"));
        assert_eq!(reducer.task.as_deref(), Some("Initial / Change / 違う"));
    }

    #[test]
    fn only_matching_resolution_clears_attention() {
        let mut reducer = LiveBriefReducer::new();
        reducer.apply(&event("q", SemanticEventKind::Question { prompt_event_id: "p1".to_string(), provider_call_id: "c1".to_string(), prompt: "Continue?".to_string(), kind: PendingInputKind::Choice, options: Vec::new() }));
        reducer.apply(&event("r", SemanticEventKind::QuestionResolved { prompt_event_id: "other".to_string(), provider_call_id: "other".to_string() }));
        assert!(reducer.pending.is_some());
        reducer.apply(&event("r2", SemanticEventKind::QuestionResolved { prompt_event_id: "p1".to_string(), provider_call_id: "c1".to_string() }));
        assert!(reducer.pending.is_none());
    }
}
