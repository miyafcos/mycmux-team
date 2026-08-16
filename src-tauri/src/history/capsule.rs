use serde_json::Value;

use super::model::{CapsuleState, MachineTurnCapsule, SemanticFields, StoredEvent, TestResult};

pub(crate) fn turn_ids(
    logical_session_id: &str,
    events: &[StoredEvent],
    existing_open_turn_id: Option<&str>,
) -> Vec<Option<String>> {
    let mut active = existing_open_turn_id.map(str::to_owned);
    events
        .iter()
        .map(|event| {
            if is_user_message(event) {
                active = Some(format!("{logical_session_id}:{}", event.event_id));
            }
            active.clone()
        })
        .collect()
}

pub(crate) fn build_capsules(
    logical_session_id: &str,
    source_log: &str,
    events: &[StoredEvent],
) -> Vec<MachineTurnCapsule> {
    let mut completed = Vec::new();
    let mut active: Option<CapsuleBuilder> = None;
    for event in events {
        if is_user_message(event) {
            if let Some(builder) = active.take() {
                completed.push(builder.finish_closed(&event.event_id, event.timestamp));
            }
            active = Some(CapsuleBuilder::new(logical_session_id, source_log, event));
        } else if let Some(builder) = active.as_mut() {
            builder.apply(event);
        }
    }
    if let Some(builder) = active {
        completed.push(builder.finish_open());
    }
    completed
}

#[derive(Clone, Debug)]
struct CapsuleBuilder {
    capsule: MachineTurnCapsule,
}

impl CapsuleBuilder {
    fn new(logical_session_id: &str, source_log: &str, event: &StoredEvent) -> Self {
        let mut evidence_event_ids = Vec::new();
        push_unique(&mut evidence_event_ids, event.event_id.clone());
        Self {
            capsule: MachineTurnCapsule {
                turn_id: format!("{logical_session_id}:{}", event.event_id),
                logical_session_id: logical_session_id.to_string(),
                source_log: source_log.to_string(),
                opened_by_event_id: event.event_id.clone(),
                closed_by_event_id: None,
                state: CapsuleState::Open,
                started_at: event.timestamp,
                ended_at: None,
                read_files: Vec::new(),
                written_files: Vec::new(),
                commands: Vec::new(),
                test_results: Vec::new(),
                errors: Vec::new(),
                evidence_event_ids,
                semantic: SemanticFields::default(),
            },
        }
    }

    fn apply(&mut self, event: &StoredEvent) {
        let Ok(value) = serde_json::from_slice::<Value>(&event.payload_json) else {
            return;
        };
        let Some(kind) = value.get("kind").and_then(Value::as_object) else {
            return;
        };
        let Some(event_type) = kind.get("type").and_then(Value::as_str) else {
            return;
        };
        match event_type {
            "fileChange" => {
                if let Some(path) = non_empty_string(kind.get("path")) {
                    push_unique(&mut self.capsule.written_files, path.to_string());
                    self.evidence(event);
                }
            }
            "testResult" => {
                let Some(pass) = kind.get("pass").and_then(Value::as_u64) else {
                    return;
                };
                let Some(fail) = kind.get("fail").and_then(Value::as_u64) else {
                    return;
                };
                self.capsule.test_results.push(TestResult {
                    pass,
                    fail,
                    evidence_event_id: event.event_id.clone(),
                });
                self.evidence(event);
            }
            "error" => {
                if let Some(text) = non_empty_string(kind.get("text")) {
                    push_unique(&mut self.capsule.errors, text.to_string());
                    self.evidence(event);
                }
            }
            "toolEnd" => self.apply_tool_end(kind, event),
            _ => {}
        }
    }

    fn apply_tool_end(&mut self, kind: &serde_json::Map<String, Value>, event: &StoredEvent) {
        let Some(tool) = non_empty_string(kind.get("tool")) else {
            return;
        };
        let ok = kind.get("ok").and_then(Value::as_bool);
        let target = non_empty_string(kind.get("target"));
        if ok == Some(false) {
            if let Some(summary) = non_empty_string(kind.get("summary")) {
                push_unique(&mut self.capsule.errors, format!("{tool}: {summary}"));
                self.evidence(event);
            }
            return;
        }
        if ok != Some(true) {
            return;
        }
        let Some(target) = target else {
            return;
        };
        match tool.to_ascii_lowercase().as_str() {
            "read" => {
                push_unique(&mut self.capsule.read_files, target.to_string());
                self.evidence(event);
            }
            "write" | "edit" | "apply_patch" => {
                push_unique(&mut self.capsule.written_files, target.to_string());
                self.evidence(event);
            }
            "bash" | "shell_command" => {
                push_unique(&mut self.capsule.commands, target.to_string());
                self.evidence(event);
            }
            _ => {}
        }
    }

    fn evidence(&mut self, event: &StoredEvent) {
        push_unique(&mut self.capsule.evidence_event_ids, event.event_id.clone());
    }

    fn finish_closed(mut self, closed_by_event_id: &str, ended_at: i64) -> MachineTurnCapsule {
        self.capsule.state = CapsuleState::Closed;
        self.capsule.closed_by_event_id = Some(closed_by_event_id.to_string());
        self.capsule.ended_at = Some(ended_at);
        self.capsule
    }

    fn finish_open(self) -> MachineTurnCapsule {
        self.capsule
    }
}

fn is_user_message(event: &StoredEvent) -> bool {
    serde_json::from_slice::<Value>(&event.payload_json)
        .ok()
        .and_then(|value| {
            value
                .pointer("/kind/type")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .as_deref()
        == Some("userMessage")
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|current| current == &value) {
        values.push(value);
    }
}
