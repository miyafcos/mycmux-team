use serde::{Deserialize, Serialize};

use super::adapter::{SemanticEventEnvelope, SemanticEventKind, UserMessageKind};
use super::telemetry::{TelemetryAccumulator, TelemetryDelta};
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
    naming: super::naming::NamingState,
    open_tools: Vec<(String, String, Option<String>, String)>,
    activity: Option<(String, String, String)>,
    checkpoint: Option<(String, Vec<String>)>,
    pending: Option<(String, String, String, PendingInputKind, Vec<PendingOption>)>,
    event_seq: u64,
    last_event_at: Option<i64>,
    telemetry: TelemetryAccumulator,
}

impl LiveBriefReducer {
    pub fn new() -> Self { Self { task: None, latest_instruction: None, task_source_event_ids: Vec::new(), naming: Default::default(), open_tools: Vec::new(), activity: None, checkpoint: None, pending: None, event_seq: 0, last_event_at: None, telemetry: TelemetryAccumulator::default() } }

    pub(crate) fn naming_source(&mut self, start: u64, end: u64, unknown: bool, pending: bool) { self.naming.source(start, end, unknown, pending); }
    pub(crate) fn naming_evicted(&mut self, event: &SemanticEventEnvelope) { self.naming.evicted(event); }
    pub(crate) fn naming_unknown(&mut self) { self.naming.unknown(); }
    pub(crate) fn naming_retains(&self, id: &str) -> bool { self.naming.retains(id) }
    pub(crate) fn naming_plan(&self) -> super::naming::NamingPlan { self.naming.plan() }

    /// Replacement history must not retain old task text or billing, but omitted
    /// current questions/tools still need their later resolutions to take effect.
    pub fn inherit_open_work(&mut self, previous: &Self) {
        self.open_tools = previous.open_tools.clone();
        self.pending = previous.pending.clone();
    }

    pub fn retains_work_event(&self, event: &SemanticEventEnvelope) -> bool {
        match &event.kind {
            SemanticEventKind::Question { prompt_event_id, .. } =>
                self.pending.as_ref().is_some_and(|pending| pending.0 == *prompt_event_id),
            SemanticEventKind::ToolStart { call_id, .. } =>
                self.open_tools.iter().any(|(id, _, _, _)| id == call_id),
            _ => false,
        }
    }

    pub fn apply_telemetry(&mut self, delta: TelemetryDelta) {
        self.telemetry.apply(delta);
    }

    pub fn reset_telemetry(&mut self) {
        self.telemetry.reset();
    }

    pub fn apply(&mut self, event: &SemanticEventEnvelope) {
        self.event_seq = self.event_seq.saturating_add(1);
        self.last_event_at = Some(event.occurred_at);
        // Capture the proof before a mixed record resolves the open question.
        let choice = matches!(&event.kind, SemanticEventKind::UserMessage {text, ..}
            if self.pending.as_ref().is_some_and(|pending| pending.4.iter().any(|option| text == &option.id || text == &option.label)));
        self.naming.observe(event, choice);
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
            SemanticEventKind::ToolStart { call_id, tool, target } => {
                self.open_tools.retain(|(id, _, _, _)| id != call_id);
                self.open_tools.push((call_id.clone(), tool.clone(), target.clone(), event.event_id.clone()));
            },
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
            naming_source_event_ids: self.naming.user_ids(), naming_plan: Some(self.naming.plan()),
            activity_kind: activity.as_ref().map(|activity| activity.0.clone()), activity_text: activity.as_ref().map(|activity| activity.1.clone()), activity_source_event_id: activity.as_ref().map(|activity| activity.2.clone()),
            checkpoint: self.checkpoint.as_ref().map(|checkpoint| checkpoint.0.clone()), checkpoint_evidence_event_ids: self.checkpoint.as_ref().map(|checkpoint| checkpoint.1.clone()).unwrap_or_default(),
            pending_input_kind: pending.as_ref().map(|pending| pending.3.clone()), pending_prompt: pending.as_ref().map(|pending| pending.2.clone()), pending_options: pending.as_ref().map(|pending| pending.4.clone()).unwrap_or_default(),
            prompt_event_id: pending.as_ref().map(|pending| pending.0.clone()), prompt_hash,
            event_seq: self.event_seq, operational_state: if pending.is_some() { "needsHuman".to_string() } else if activity.is_some() { "running".to_string() } else { "ready".to_string() }, telemetry_health: health.to_string(),
            last_event_at: self.last_event_at, last_successful_read_at: Some(now), updated_at: now, service_epoch: service_epoch.to_string(), brief_revision: 0,
            autonomy: None, telemetry: self.telemetry.to_telemetry(),
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
    fn naming_choice_proof_is_captured_before_resolution_without_reclassifying_answer() {
        for (text, choice) in [("A", true), ("動画", true), ("A追加", false), ("追記A", false), ("動画を編集する", false)] {
            let mut reducer = LiveBriefReducer::new();
            reducer.apply(&event("task", SemanticEventKind::UserMessage {kind: UserMessageKind::TaskStart, text: "Initial".into(), digest: String::new()}));
            reducer.apply(&event("q", SemanticEventKind::Question {prompt_event_id: "q".into(), provider_call_id: "call".into(), prompt: "Which?".into(),
                kind: PendingInputKind::Choice, options: vec![PendingOption::new("A".into(), "動画".into(), String::new())]}));
            reducer.apply(&event("answer", SemanticEventKind::UserMessage {kind: UserMessageKind::Answer, text: text.into(), digest: String::new()}));
            reducer.apply(&event("resolved", SemanticEventKind::QuestionResolved {prompt_event_id: "q".into(), provider_call_id: "call".into()}));
            let mark = reducer.naming_plan().latest_input.unwrap(); assert_eq!(mark.choice, choice); assert_eq!(mark.kind, UserMessageKind::Answer);
            assert_eq!(reducer.latest_instruction.as_deref(), Some("Initial")); assert!(reducer.pending.is_none());
        }
        let mut reducer = LiveBriefReducer::new(); let label = "動画ではなく解説スライドを作る";
        reducer.apply(&event("q", SemanticEventKind::Question {prompt_event_id: "q".into(), provider_call_id: "call".into(), prompt: "Which?".into(),
            kind: PendingInputKind::Choice, options: vec![PendingOption::new("A".into(), label.into(), String::new())]}));
        reducer.apply(&event("choice", SemanticEventKind::UserMessage {kind: UserMessageKind::Correction, text: label.into(), digest: String::new()}));
        assert!(reducer.naming_plan().latest_input.unwrap().choice); assert_eq!(reducer.latest_instruction.as_deref(), Some(label));
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

    #[test]
    fn telemetry_accumulates_into_the_brief() {
        use crate::livebrief::telemetry::{BillableTokens, TelemetryDelta};
        let mut reducer = LiveBriefReducer::new();
        reducer.apply_telemetry(TelemetryDelta {
            model: Some("claude-sonnet-4-6".to_string()),
            effort: Some("high".to_string()),
            occupancy_tokens: Some(40_000),
            billable: Some(BillableTokens {
                input: 1_000_000,
                output: 0,
                model: Some("claude-sonnet-4-6".to_string()),
                ..BillableTokens::default()
            }),
            turn_inc: 1,
            compact_inc: 2,
            real_turn: true,
            ..TelemetryDelta::default()
        });
        let brief = reducer.to_brief(
            LiveBinding {
                pty_session_id: "pty".into(),
                agent_session_id: "agent".into(),
                agent_kind: "claude".into(),
                pty_instance_id: "instance".into(),
                pty_generation: 1,
                source_revision: 1,
                pty_input_revision: 1,
            },
            "live",
            "epoch",
            1,
        );
        let telemetry = brief.telemetry.expect("telemetry");
        assert_eq!(telemetry.model.as_ref().unwrap().name, "sonnet-4.6");
        assert_eq!(telemetry.model.as_ref().unwrap().effort.as_deref(), Some("high"));
        assert_eq!(telemetry.context.as_ref().unwrap().pct, Some(4));
        assert_eq!(telemetry.turns.as_ref().unwrap().count, 1);
        assert_eq!(telemetry.turns.as_ref().unwrap().compacts, 2);
        assert!((telemetry.cost.as_ref().unwrap().usd - 3.0).abs() < 1e-9);
    }
}
