use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub const MAX_INPUT_BYTES: usize = 16 * 1024;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_UPDATES: usize = 128;
pub const MAX_OPERATIONS: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DshRunRef {
    pub run_id: String,
    pub generation: u64,
    pub conv_id: Option<String>,
    pub cwd: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshDelivery {
    pub operation_id: String,
    pub request_id: String,
    pub submitted_at_ms: i64,
    /// ACP has no independent acceptance receipt. Writing bytes is not acceptance.
    pub accepted_at_ms: Option<i64>,
    pub observed_at_ms: Option<i64>,
    pub settled_at_ms: Option<i64>,
    pub status: String,
    pub stop_reason: Option<String>,
    pub cancel_requested: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshUpdate {
    pub sequence: u64,
    pub source: String,
    pub operation_id: Option<String>,
    pub kind: String,
    pub text: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshRead {
    pub source: String,
    pub run: DshRunRef,
    pub cursor: u64,
    pub updates: Vec<DshUpdate>,
    pub truncated: bool,
    pub gap: bool,
    pub history_available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshPermission {
    pub permission_id: String,
    pub operation_id: String,
    pub allow_available: bool,
    pub reject_available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshState {
    pub version: u32,
    pub enabled: bool,
    pub run: Option<DshRunRef>,
    pub required_executable_version: String,
    pub executable_version: Option<String>,
    pub agent_info_version: Option<String>,
    pub resume_supported: bool,
    pub process: String,
    pub activity: String,
    pub confidence: String,
    pub session_closed: bool,
    pub delivery: Option<DshDelivery>,
    pub permissions: Vec<DshPermission>,
    pub read: Option<DshRead>,
    pub error: Option<String>,
}

impl Default for DshState {
    fn default() -> Self {
        Self {
            version: 1, enabled: false, run: None,
            required_executable_version: super::PINNED_VERSION.into(),
            executable_version: None, agent_info_version: None, resume_supported: false,
            process: "notStarted".into(), activity: "unknown".into(), confidence: "unknown".into(),
            session_closed: false, delivery: None, permissions: vec![], read: None, error: None,
        }
    }
}

#[derive(Default)]
pub(super) struct Core {
    pub state: DshState,
    pub inflight: Option<String>,
    operations: HashMap<String, (String, DshDelivery)>,
    updates: Vec<DshUpdate>,
    sequence: u64,
    text_bytes: usize,
    truncated: bool,
}

pub(super) fn opaque_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        return Err("invalid conversation ID".into());
    }
    Ok(())
}

pub(super) fn operation_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b)) {
        return Err("invalid operation ID".into());
    }
    Ok(())
}

pub(super) fn bounded_text(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) { end -= 1; }
    text[..end].into()
}

/// Only display selected text, never raw tool payloads, errors or environment dumps.
/// Known credential shapes and assignment lines are removed before buffering.
pub(super) fn display_text(text: &str) -> String {
    text.split_inclusive('\n').map(|line| {
        let upper = line.to_ascii_uppercase();
        if ["API_KEY", "ACCESS_TOKEN", "AUTHORIZATION", "PASSWORD", "CLIENT_SECRET", "BEARER ", "CREDENTIAL"].iter().any(|word| upper.contains(word)) {
            return "[redacted]\n".into();
        }
        line.split_inclusive(char::is_whitespace).map(|word| {
            if word.contains("sk-") || word.contains("ghp_") || word.contains("github_pat_") || word.contains("eyJ") {
                "[redacted] ".into()
            } else { word.to_string() }
        }).collect::<String>()
    }).collect()
}

pub(super) fn initialize_params() -> Value {
    json!({"protocolVersion":1,"clientInfo":{"name":"mycmux","version":"dsh-experiment-1"},
        "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}})
}

impl Core {
    pub fn require_run(&self, expected: &DshRunRef) -> Result<(), String> {
        if self.state.run.as_ref() != Some(expected) || expected.conv_id.is_none() {
            return Err("stale or mismatched dsh run reference".into());
        }
        if self.state.session_closed { return Err("dsh session is closed".into()); }
        if self.state.activity == "unknown" || self.state.process != "running" {
            return Err("dsh outcome unknown or process unavailable; stop before reconnecting".into());
        }
        Ok(())
    }

    pub fn initialized(&mut self, response: &Value) -> Result<(), String> {
        if response.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
            return Err("unsupported: ACP protocol version".into());
        }
        let caps = response.get("agentCapabilities").and_then(Value::as_object)
            .ok_or("unsupported: missing ACP capabilities")?;
        let sessions = caps.get("sessionCapabilities").and_then(Value::as_object)
            .ok_or("unsupported: missing ACP session capabilities")?;
        if !sessions.get("close").is_some_and(Value::is_object) {
            return Err("unsupported: ACP session/close capability required".into());
        }
        self.state.resume_supported = sessions.get("resume").is_some_and(Value::is_object)
            && sessions.get("list").is_some_and(Value::is_object);
        self.state.agent_info_version = response.pointer("/agentInfo/version").and_then(Value::as_str)
            .filter(|s| s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b)))
            .map(str::to_string);
        Ok(())
    }

    pub fn opened(&mut self, response: &Value, resume: Option<&str>) -> Result<(), String> {
        if self.state.activity == "unknown" && self.state.error.is_some() {
            return Err("ACP connection lost during session open; outcome unknown".into());
        }
        if !response.is_object() { return Err("invalid ACP session response".into()); }
        let run = self.state.run.as_mut().ok_or("no owned dsh run")?;
        if response.get("cwd").is_some_and(|cwd| cwd.as_str() != Some(run.cwd.as_str())) {
            return Err("ACP session cwd mismatch".into());
        }
        let id = match resume {
            Some(id) => {
                if response.get("sessionId").is_some_and(|value| value.as_str() != Some(id)) {
                    return Err("ACP resume conversation ID mismatch".into());
                }
                id
            }
            None => response.get("sessionId").and_then(Value::as_str).ok_or("ACP new did not return a conversation ID")?,
        };
        opaque_id(id)?;
        run.conv_id = Some(id.into());
        self.state.activity = "quiescent".into();
        self.state.confidence = "observed".into();
        Ok(())
    }

    pub fn reserve(&mut self, expected: &DshRunRef, operation: &str, text: &str, request: &str) -> Result<(bool, DshDelivery), String> {
        self.require_run(expected)?;
        operation_id(operation)?;
        if text.trim().is_empty() || text.len() > MAX_INPUT_BYTES { return Err("prompt must contain 1..16384 UTF-8 bytes".into()); }
        let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
        if let Some((prior_digest, receipt)) = self.operations.get(operation) {
            if prior_digest != &digest { return Err("operation ID already used with different text".into()); }
            return Ok((false, receipt.clone()));
        }
        if self.inflight.is_some() { return Err("one dsh prompt is already in flight".into()); }
        if self.operations.len() >= MAX_OPERATIONS { return Err("operation limit reached; close and reconnect explicitly".into()); }
        let delivery = DshDelivery {
            operation_id: operation.into(), request_id: request.into(),
            submitted_at_ms: chrono::Utc::now().timestamp_millis(), accepted_at_ms: None,
            observed_at_ms: None, settled_at_ms: None, status: "submitted".into(), stop_reason: None,
            cancel_requested: false,
        };
        self.operations.insert(operation.into(), (digest, delivery.clone()));
        self.state.delivery = Some(delivery.clone());
        self.inflight = Some(operation.into());
        self.state.activity = "pending".into();
        self.state.confidence = "inferred".into();
        Ok((true, delivery))
    }

    fn save_delivery(&mut self) {
        if let Some(delivery) = &self.state.delivery {
            if let Some((_, receipt)) = self.operations.get_mut(&delivery.operation_id) { *receipt = delivery.clone(); }
        }
    }

    pub fn cancel_requested(&mut self) {
        if let Some(delivery) = self.state.delivery.as_mut() { delivery.cancel_requested = true; }
        self.save_delivery();
    }

    pub fn settle(&mut self, operation: &str, response: Result<Value, super::RpcFailure>) {
        if self.inflight.as_deref() != Some(operation) || self.state.activity == "unknown" { return; }
        let delivery = self.state.delivery.as_mut().expect("reserved prompt");
        match response {
            Ok(value) => match value.get("stopReason").and_then(Value::as_str) {
                Some(reason @ ("end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal")) => {
                    delivery.status = if reason == "cancelled" { "cancelled" } else { "settled" }.into();
                    delivery.stop_reason = Some(reason.into());
                    delivery.settled_at_ms = Some(chrono::Utc::now().timestamp_millis());
                    self.state.activity = "quiescent".into();
                    self.state.confidence = "observed".into();
                }
                _ => { self.lost("invalid ACP prompt settlement; do not resend"); return; }
            },
            Err(super::RpcFailure::Rejected) => {
                delivery.status = "rejected".into();
                delivery.settled_at_ms = Some(chrono::Utc::now().timestamp_millis());
                self.state.activity = "quiescent".into();
                self.state.confidence = "observed".into();
                self.state.error = Some("ACP rejected the prompt; remote details withheld".into());
            }
            Err(super::RpcFailure::Unknown) => { self.lost("ACP outcome unknown; do not resend"); return; }
        }
        self.inflight = None;
        self.state.permissions.clear();
        self.save_delivery();
    }

    pub fn lost(&mut self, reason: &str) {
        self.state.activity = "unknown".into();
        self.state.confidence = "unknown".into();
        self.state.error = Some(reason.into());
        self.state.permissions.clear();
        if self.inflight.is_some() {
            if let Some(delivery) = self.state.delivery.as_mut() { delivery.status = "unknown".into(); }
        }
        self.save_delivery();
    }

    pub fn update(&mut self, params: &Value) {
        let Some(run) = &self.state.run else { return; };
        if run.conv_id.is_none() || params.get("sessionId").and_then(Value::as_str) != run.conv_id.as_deref()
            || self.state.session_closed || self.state.activity == "unknown" { return; }
        let update = &params["update"];
        let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else { return; };
        let text = match kind {
            "agent_message_chunk" if update.pointer("/content/type").and_then(Value::as_str) == Some("text") => {
                let Some(text) = update.pointer("/content/text").and_then(Value::as_str) else { return; };
                Some(display_text(text))
            }
            "agent_thought_chunk" | "tool_call" | "tool_call_update" | "config_option_update" | "usage_update" => None,
            _ => return,
        };
        if let Some(delivery) = self.state.delivery.as_mut().filter(|_| self.inflight.is_some()) {
            delivery.observed_at_ms.get_or_insert_with(|| chrono::Utc::now().timestamp_millis());
            delivery.status = "observed".into();
        }
        self.save_delivery();
        let text = text.map(|text| {
            let cropped = bounded_text(&text, MAX_TEXT_BYTES);
            self.truncated |= cropped.len() < text.len();
            cropped
        });
        self.sequence += 1;
        self.text_bytes += text.as_ref().map_or(0, String::len);
        self.updates.push(DshUpdate { sequence: self.sequence, source: "acpUpdate".into(),
            operation_id: self.inflight.clone(), kind: kind.into(), text });
        while self.updates.len() > MAX_UPDATES || self.text_bytes > MAX_TEXT_BYTES {
            let first = self.updates.remove(0);
            self.text_bytes -= first.text.as_ref().map_or(0, String::len);
            self.truncated = true;
        }
    }

    pub fn read(&self, cursor: u64) -> Result<DshRead, String> {
        if cursor > self.sequence { return Err("cursor is ahead of this dsh run".into()); }
        let first = self.updates.first().map_or(self.sequence + 1, |u| u.sequence);
        Ok(DshRead { source: "acpUpdates".into(), run: self.state.run.clone().ok_or("no dsh run")?,
            cursor: self.sequence, updates: self.updates.iter().filter(|u| u.sequence > cursor).cloned().collect(),
            truncated: self.truncated, gap: cursor < first.saturating_sub(1), history_available: false })
    }

    pub fn snapshot(&self) -> DshState {
        let mut state = self.state.clone();
        state.read = self.read(0).ok();
        state
    }
}
