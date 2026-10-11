//! Naming-only selection proof. No task interpretation or retained conversation body.
use super::{sha256_hex, SemanticEventEnvelope, SemanticEventKind, UserMessageKind};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InputMark {
    pub event_id: String, pub order: u64, pub source_byte_start: u64, pub source_byte_end: u64,
    pub kind: UserMessageKind, pub choice: bool, pub complete: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Allocation {
    pub event_id: String, pub order: u64, pub source_revision: u64,
    pub source_byte_start: u64, pub source_byte_end: u64,
    pub role: String, pub chars: usize, pub complete: bool, pub hash: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub read_start: u64, pub read_end: u64, pub source_unknown: bool,
    pub count_loss: Option<u64>, pub character_loss: Option<u64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NamingPlan {
    pub latest_input: Option<InputMark>, pub latest_agent: Option<Allocation>,
    pub entries: Vec<Allocation>, pub coverage: Coverage,
}
impl NamingPlan {
    pub fn history_complete(&self) -> bool {
        !self.coverage.source_unknown && self.coverage.count_loss.is_none() && self.coverage.character_loss.is_none()
    }
    pub fn same_meaning(&self, other: &Self) -> bool {
        let mut a = self.clone(); let mut b = other.clone();
        a.coverage.read_start = 0; a.coverage.read_end = 0;
        b.coverage.read_start = 0; b.coverage.read_end = 0;
        a == b
    }
}
#[derive(Clone, Debug, Default)]
pub(crate) struct NamingState {
    users: Vec<Allocation>, others: Vec<Allocation>, latest_input: Option<InputMark>,
    latest_agent: Option<Allocation>, coverage: Coverage, pending_source: bool, order: u64,
}
fn loss(at: &mut Option<u64>, end: u64) { *at = Some(at.unwrap_or(0).max(end)); }
pub(crate) fn field(event: &SemanticEventEnvelope) -> (String, String) {
    match &event.kind {
        SemanticEventKind::UserMessage {text, ..} => ("user".into(), text.clone()),
        SemanticEventKind::AgentMessage {text} => ("agent".into(), text.clone()),
        SemanticEventKind::FileChange {path, ..} => ("write".into(), basename(path)),
        SemanticEventKind::ToolStart {tool, target: Some(path), ..}
        | SemanticEventKind::ToolEnd {tool, target: Some(path), ..} => {
            let role = match tool.to_ascii_lowercase().as_str() { "read" => "read", "edit" | "write" => "write", _ => "other" };
            (role.into(), if role == "other" {String::new()} else {basename(path)})
        }
        _ => ("other".into(), String::new()),
    }
}
fn basename(path: &str) -> String { path.replace('\\', "/").rsplit('/').next().unwrap_or("").to_owned() }
impl NamingState {
    pub fn source(&mut self, start: u64, end: u64, unknown: bool, pending: bool) {
        if self.order == 0 && self.coverage.read_end == 0 { self.coverage.read_start = start; }
        self.coverage.read_end = self.coverage.read_end.max(end);
        self.coverage.source_unknown |= unknown; self.pending_source = pending;
    }
    pub fn unknown(&mut self) { self.coverage.source_unknown = true; }
    pub fn retains(&self, id: &str) -> bool { self.users.iter().chain(&self.others).any(|entry| entry.event_id == id) }
    pub fn evicted(&mut self, event: &SemanticEventEnvelope) {
        if matches!(&event.kind, SemanticEventKind::UserMessage {kind, ..} if *kind != UserMessageKind::Ack) {
            loss(&mut self.coverage.count_loss, event.source_byte_end);
        }
        self.users.retain(|entry| entry.event_id != event.event_id);
        self.others.retain(|entry| entry.event_id != event.event_id);
    }
    pub fn observe(&mut self, event: &SemanticEventEnvelope, choice: bool) {
        self.order = self.order.saturating_add(1);
        self.coverage.read_end = self.coverage.read_end.max(event.source_byte_end);
        let (role, text) = field(event);
        let entry = Allocation {event_id: event.event_id.clone(), order: self.order,
            source_revision: event.source_revision, source_byte_start: event.source_byte_start,
            source_byte_end: event.source_byte_end, role, chars: text.chars().count(), complete: true,
            hash: sha256_hex(text.as_bytes())};
        if let SemanticEventKind::UserMessage {kind, ..} = &event.kind {
            self.latest_input = Some(InputMark {event_id: event.event_id.clone(), order: self.order,
                source_byte_start: event.source_byte_start, source_byte_end: event.source_byte_end,
                kind: *kind, choice, complete: *kind == UserMessageKind::Ack});
            if *kind == UserMessageKind::Ack { return; }
            if self.users.len() == 4 { loss(&mut self.coverage.count_loss, self.users[0].source_byte_end); self.users.remove(0); }
            self.users.push(entry);
        } else {
            if entry.role == "agent" { self.latest_agent = Some(entry.clone()); }
            if self.others.len() == 20 { self.others.remove(0); }
            self.others.push(entry);
        }
    }
    pub fn user_ids(&self) -> Vec<String> { self.users.iter().map(|entry| entry.event_id.clone()).collect() }
    pub fn plan(&self) -> NamingPlan {
        let mut plan = NamingPlan {latest_input: self.latest_input.clone(), latest_agent: self.latest_agent.clone(),
            entries: Vec::new(), coverage: self.coverage.clone()};
        plan.coverage.source_unknown |= self.pending_source;
        let (mut users, mut agents, mut files) = (1600usize, 600usize, 640usize);
        let mut agent_count = 0; let mut file_keys = Vec::new();
        for raw in self.users.iter().rev().chain(self.others.iter().rev()) {
            let (budget, cap) = match raw.role.as_str() {
                "user" => (&mut users, 1600),
                "agent" if agent_count < 2 => { agent_count += 1; (&mut agents, 300) }
                "read" | "write" if file_keys.len() < 8 && !file_keys.contains(&(&raw.hash, &raw.role)) => {
                    file_keys.push((&raw.hash, &raw.role)); (&mut files, 80)
                }
                _ => continue,
            };
            let mut entry = raw.clone(); entry.chars = raw.chars.min(*budget).min(cap);
            entry.complete = entry.chars == raw.chars; *budget -= entry.chars;
            if !entry.complete && entry.role == "user" { loss(&mut plan.coverage.character_loss, entry.source_byte_end); }
            if entry.chars > 0 { plan.entries.push(entry); }
        }
        plan.entries.sort_by_key(|entry| entry.order);
        if let Some(mark) = &mut plan.latest_input {
            if mark.kind != UserMessageKind::Ack { mark.complete = plan.entries.iter().any(|entry| entry.event_id == mark.event_id && entry.complete); }
        }
        if let Some(mark) = &mut plan.latest_agent {
            mark.complete = plan.entries.iter().any(|entry| entry.event_id == mark.event_id && entry.complete);
        }
        plan
    }
}
/// Project only planned bodies. Missing or altered cache/ring entries fail closed.
pub(crate) fn project<'a>(plan: &NamingPlan, events: impl Iterator<Item = &'a SemanticEventEnvelope>) -> Vec<SemanticEventEnvelope> {
    let events: Vec<_> = events.collect();
    plan.entries.iter().filter_map(|entry| {
        let raw = events.iter().find(|event| event.event_id == entry.event_id)?;
        let (role, text) = field(raw);
        if role != entry.role || raw.source_revision != entry.source_revision || raw.source_byte_start != entry.source_byte_start
            || raw.source_byte_end != entry.source_byte_end || sha256_hex(text.as_bytes()) != entry.hash { return None; }
        if plan.latest_input.as_ref().is_some_and(|mark| mark.event_id == entry.event_id
            && !matches!(&raw.kind, SemanticEventKind::UserMessage {kind, ..} if *kind == mark.kind)) { return None; }
        let mut event = (**raw).clone(); let text = text.chars().take(entry.chars).collect();
        match &mut event.kind {
            SemanticEventKind::UserMessage {text: value, ..} | SemanticEventKind::AgentMessage {text: value} => *value = text,
            SemanticEventKind::FileChange {path, ..} => *path = text,
            SemanticEventKind::ToolStart {target, ..} => *target = Some(text),
            SemanticEventKind::ToolEnd {target, summary, ..} => { *target = Some(text); *summary = None; }
            _ => return None,
        }
        Some(event)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn user(i: u64, text: &str, kind: UserMessageKind) -> SemanticEventEnvelope {
        SemanticEventEnvelope {event_id: format!("u-{i}"), source_revision: i, occurred_at: 0,
            source_byte_start: i * 100, source_byte_end: i * 100 + 99,
            kind: SemanticEventKind::UserMessage {kind, text: text.into(), digest: String::new()}}
    }
    #[test]
    fn count_loss_and_ack_survive_equal_text_with_distinct_ids() {
        let mut state = NamingState::default();
        for i in 0..5 { state.observe(&user(i, "同じ文", UserMessageKind::TaskChange), false); }
        state.observe(&user(5, "はい", UserMessageKind::Ack), false);
        let plan = state.plan(); assert_eq!(plan.entries.len(), 4); assert_eq!(plan.coverage.count_loss, Some(99));
        assert_eq!(state.user_ids(), ["u-1", "u-2", "u-3", "u-4"]);
        assert_eq!(plan.latest_input.unwrap().event_id, "u-5"); assert_eq!(plan.entries.iter().map(|e| e.chars).sum::<usize>(), 12);
        state.evicted(&user(4, "同じ文", UserMessageKind::TaskChange));
        state.observe(&user(6, "新しい直接指示", UserMessageKind::TaskChange), false);
        let plan = state.plan(); assert_eq!(plan.coverage.count_loss, Some(499)); assert!(plan.latest_input.unwrap().complete);
        assert!(!plan.entries.iter().any(|entry| entry.event_id == "u-4"));
    }
    #[test]
    fn zero_and_partial_character_losses_precede_omission() {
        for pad in ["あ", "😀", "e\u{301}"] { for size in [1599, 1600, 1601] {
            let mut state = NamingState::default(); state.observe(&user(0, "禁止", UserMessageKind::TaskChange), false);
            let text: String = pad.repeat(size).chars().take(size).collect();
            state.observe(&user(1, &text, UserMessageKind::TaskChange), false);
            let plan = state.plan(); assert!(plan.coverage.character_loss.is_some()); assert!(!plan.history_complete());
            assert!(plan.entries.iter().map(|e| e.chars).sum::<usize>() <= 1600);
            assert_eq!(plan.latest_input.unwrap().complete, size <= 1600);
            if size >= 1600 { assert!(!plan.entries.iter().any(|e| e.event_id == "u-0")); }
        } }
    }
    #[test]
    fn latest_agent_and_missing_or_changed_bodies_are_never_rescued() {
        let mut state = NamingState::default(); let mut old = user(0, "", UserMessageKind::TaskStart);
        old.kind = SemanticEventKind::AgentMessage {text: "動画を編集する".into()}; state.observe(&old, false);
        let mut current = old.clone(); current.event_id = "current".into(); current.kind = SemanticEventKind::AgentMessage {text: "あ".repeat(301)};
        state.observe(&current, false); let plan = state.plan(); assert!(!plan.latest_agent.as_ref().unwrap().complete);
        assert_eq!(project(&plan, [&old, &current].into_iter()).len(), 2);
        current.kind = SemanticEventKind::AgentMessage {text: "改変".into()}; assert_eq!(project(&plan, [&old, &current].into_iter()).len(), 1);
        for i in 1..=20 { let mut event = user(i, "", UserMessageKind::TaskStart); event.kind = SemanticEventKind::TestResult {pass: 0, fail: 0}; state.observe(&event, false); }
        let plan = state.plan(); assert!(!plan.latest_agent.unwrap().complete); assert!(plan.entries.is_empty());
    }
    #[test]
    fn wire_proof_is_bounded_and_read_offsets_do_not_change_meaning() {
        let mut state = NamingState::default(); state.observe(&user(0, "非公開の本文", UserMessageKind::TaskStart), false);
        let before = state.plan(); state.source(0, 500, false, false); let after = state.plan();
        assert!(before.same_meaning(&after)); let raw = serde_json::to_string(&after).unwrap(); assert!(!raw.contains("非公開"));
        assert_eq!(serde_json::from_str::<NamingPlan>(&raw).unwrap(), after);
        state.source(500, 900, true, false); assert!(state.plan().coverage.source_unknown);
        state.source(0, 1000, false, false); assert!(state.plan().coverage.source_unknown);
    }
}
