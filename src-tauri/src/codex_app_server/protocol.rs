use crate::agent_adapters::ConfigurationObservation;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAX_INPUT_BYTES: usize = 16 * 1024;
pub const MAX_REPLY_BYTES: usize = 64 * 1024;
pub const MAX_EVENTS: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub sequence: u64,
    pub at_ms: i64,
    pub method: String,
    pub source: String,
    pub operation_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReceipt {
    pub operation_id: String,
    pub request_id: String,
    pub turn_id: Option<String>,
    pub submitted_at_ms: i64,
    pub accepted_at_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    /// Unknown is an indeterminate outcome: this ID must never be resent automatically.
    pub status: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdown {
    pub token_usage: Option<Value>,
    pub chatgpt_allowance: Option<Value>,
    pub api_standard_estimate_usd: Option<f64>,
    pub extra_cost_usd: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentSnapshot {
    pub version: u32,
    pub enabled: bool,
    pub connection_id: Option<String>,
    pub cli_version: Option<String>,
    pub process_state: String,
    pub agent_state: String,
    pub thread_id: Option<String>,
    pub configuration: ConfigurationObservation,
    pub delivery: Option<DeliveryReceipt>,
    pub reply: String,
    pub reply_truncated: bool,
    pub events: Vec<EventRecord>,
    pub usage: UsageBreakdown,
    pub error: Option<String>,
}

impl Default for ExperimentSnapshot {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: false,
            connection_id: None,
            cli_version: None,
            process_state: "notStarted".into(),
            agent_state: "unknown".into(),
            thread_id: None,
            configuration: ConfigurationObservation::default(),
            delivery: None,
            reply: String::new(),
            reply_truncated: false,
            events: Vec::new(),
            usage: UsageBreakdown::default(),
            error: None,
        }
    }
}

#[derive(Default)]
pub struct ProtocolState {
    pub snapshot: ExperimentSnapshot,
    send_digest: Option<String>,
    sequence: u64,
}

pub fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
    {
        return Err("invalid operation ID".into());
    }
    Ok(())
}

pub fn validate_text(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > MAX_INPUT_BYTES {
        return Err("text must be nonempty and at most 16384 UTF-8 bytes".into());
    }
    Ok(())
}

pub fn initialize_params() -> Value {
    json!({"clientInfo":{"name":"mycmux_openai_probe","title":"mycmux Codex experiment","version":"0.1.0"},
        "capabilities":{"experimentalApi":true}})
}

pub fn thread_start_params(cwd: &str) -> Value {
    // Deliberately inherit model, effort, tier, authentication and permissions.
    json!({"cwd":cwd,"ephemeral":true})
}

pub fn turn_start_params(thread: &str, text: &str, operation: &str) -> Value {
    json!({"threadId":thread,"clientUserMessageId":operation,"input":[{"type":"text","text":text}]})
}

pub fn steer_params(thread: &str, turn: &str, text: &str, operation: &str) -> Value {
    json!({"threadId":thread,"expectedTurnId":turn,"clientUserMessageId":operation,
        "input":[{"type":"text","text":text}]})
}

pub fn interrupt_params(thread: &str, turn: &str) -> Value {
    json!({"threadId":thread,"turnId":turn})
}

pub fn pinned_user_agent(user_agent: &str) -> bool {
    user_agent
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-')
        .any(|part| part == super::PINNED_VERSION)
}

impl ProtocolState {
    pub fn record(&mut self, method: &str, source: &str, operation: Option<String>, at: i64) {
        self.sequence += 1;
        self.snapshot.events.push(EventRecord {
            sequence: self.sequence,
            at_ms: at,
            method: method.into(),
            source: source.into(),
            operation_id: operation,
            thread_id: self.snapshot.thread_id.clone(),
            turn_id: self
                .snapshot
                .delivery
                .as_ref()
                .and_then(|d| d.turn_id.clone()),
        });
        if self.snapshot.events.len() > MAX_EVENTS {
            self.snapshot.events.remove(0);
        }
    }

    pub fn opened_thread(&mut self, requested: Value, response: &Value) -> Result<(), String> {
        let id = response
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("thread/start did not return a thread ID")?;
        self.snapshot.thread_id = Some(id.into());
        self.snapshot.configuration = ConfigurationObservation {
            requested,
            effective: json!({"model":response.get("model"),"effort":response.get("reasoningEffort"),
                "serviceTier":response.get("serviceTier"),"cwd":response.get("cwd")}),
            source: Some("appServerResponse:thread/start".into()),
            observed: true,
        };
        Ok(())
    }

    /// Returns false for a duplicate. A duplicate is observed, never sent again.
    pub fn reserve_send(&mut self, id: &str, text: &str, at: i64) -> Result<bool, String> {
        validate_id(id)?;
        validate_text(text)?;
        let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
        if let Some(prior) = &self.snapshot.delivery {
            if prior.operation_id == id && self.send_digest.as_deref() == Some(digest.as_str()) {
                return Ok(false);
            }
            if prior.operation_id == id {
                return Err("operation ID was already used for different text".into());
            }
            return Err("unsupported: another turn in the one-turn experiment".into());
        }
        if self.snapshot.thread_id.is_none() {
            return Err("experiment has no thread".into());
        }
        self.send_digest = Some(digest);
        self.snapshot.delivery = Some(DeliveryReceipt {
            operation_id: id.into(),
            request_id: format!("send:{id}"),
            turn_id: None,
            submitted_at_ms: at,
            accepted_at_ms: None,
            started_at_ms: None,
            completed_at_ms: None,
            status: "submitted".into(),
        });
        self.record("turn/start:submitted", "adapter", Some(id.into()), at);
        Ok(true)
    }

    pub fn accept_send(&mut self, response: &Value, at: i64) -> Result<(), String> {
        let turn_id = response
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("turn/start did not return a turn ID")?;
        let delivery = self.snapshot.delivery.as_mut().ok_or("no pending send")?;
        if delivery.turn_id.as_deref().is_some_and(|id| id != turn_id) {
            return Err("turn/start response disagrees with the observed turn ID".into());
        }
        delivery.turn_id = Some(turn_id.into());
        delivery.accepted_at_ms = Some(at);
        if delivery.started_at_ms.is_none() && delivery.completed_at_ms.is_none() {
            delivery.status = "accepted".into();
        }
        let operation = Some(delivery.operation_id.clone());
        self.record("turn/start:accepted", "appServerResponse", operation, at);
        Ok(())
    }

    pub fn active_turn(&self, expected: &str) -> Result<(String, String), String> {
        let delivery = self.snapshot.delivery.as_ref().ok_or("no active turn")?;
        if delivery.completed_at_ms.is_some()
            || delivery.status == "unknown"
            || delivery.status == "rejected"
            || delivery.turn_id.as_deref() != Some(expected)
        {
            return Err("active turn ID mismatch or turn no longer active".into());
        }
        Ok((
            self.snapshot.thread_id.clone().ok_or("no thread")?,
            expected.into(),
        ))
    }

    pub fn connection_lost(&mut self, reason: &str, at: i64) {
        // EOF or a deadline proves loss of transport, not that the child has exited.
        self.snapshot.process_state = "disconnected".into();
        self.snapshot.agent_state = "unknown".into();
        self.snapshot.error = Some(reason.into());
        if let Some(delivery) = self.snapshot.delivery.as_mut() {
            if delivery.completed_at_ms.is_none() && delivery.status != "rejected" {
                delivery.status = "unknown".into();
            }
        }
        self.record("connection/lost", "adapter", None, at);
    }

    pub fn receive_notification(&mut self, method: &str, params: &Value, at: i64) {
        if method == "account/rateLimits/updated" {
            self.snapshot.usage.chatgpt_allowance = params.get("rateLimits").cloned();
            self.record(method, "appServerEvent", None, at);
            return;
        }
        if params.get("threadId").and_then(Value::as_str) != self.snapshot.thread_id.as_deref()
            || self.snapshot.thread_id.is_none()
        {
            return;
        }
        if method == "thread/status/changed" {
            self.snapshot.agent_state =
                match params.pointer("/status/type").and_then(Value::as_str) {
                    Some("idle") => "idle",
                    Some("active") => "active",
                    Some("notLoaded") => "notLoaded",
                    Some("systemError") => "systemError",
                    _ => "unknown",
                }
                .into();
            self.record(method, "appServerEvent", None, at);
            return;
        }
        let Some(delivery) = self.snapshot.delivery.as_mut() else {
            return;
        };
        let incoming_turn = params
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
        if method == "turn/started"
            && delivery.turn_id.is_none()
            && delivery.completed_at_ms.is_none()
        {
            delivery.turn_id = incoming_turn.map(str::to_string);
        }
        if incoming_turn.is_none() || incoming_turn != delivery.turn_id.as_deref() {
            return;
        }
        let operation = Some(delivery.operation_id.clone());
        match method {
            "turn/started" => {
                if delivery.started_at_ms.is_none() {
                    delivery.started_at_ms = Some(at);
                }
                if delivery.completed_at_ms.is_none() {
                    delivery.status = "started".into();
                }
            }
            "turn/completed" => {
                if delivery.completed_at_ms.is_some() {
                    return;
                }
                delivery.completed_at_ms = Some(at);
                delivery.status = match params.pointer("/turn/status").and_then(Value::as_str) {
                    Some("completed") => "completed",
                    Some("interrupted") => "interrupted",
                    Some("failed") => "failed",
                    _ => "unknown",
                }
                .into();
                if delivery.status == "failed" {
                    self.snapshot.error = Some(
                        "Codex reported a failed turn; inspect the trial before retrying.".into(),
                    );
                }
            }
            "item/agentMessage/delta" => {
                if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                    let remaining = MAX_REPLY_BYTES.saturating_sub(self.snapshot.reply.len());
                    let mut end = remaining.min(delta.len());
                    while !delta.is_char_boundary(end) {
                        end -= 1;
                    }
                    self.snapshot.reply.push_str(&delta[..end]);
                    self.snapshot.reply_truncated |= end < delta.len();
                }
            }
            "thread/tokenUsage/updated" => {
                self.snapshot.usage.token_usage = params.get("tokenUsage").cloned();
            }
            "model/rerouted" => {
                self.snapshot.configuration.effective["model"] =
                    params.get("toModel").cloned().unwrap_or(Value::Null);
                self.snapshot.configuration.source = Some("appServerEvent:model/rerouted".into());
            }
            _ => {}
        }
        self.record(method, "appServerEvent", operation, at);
    }
}
