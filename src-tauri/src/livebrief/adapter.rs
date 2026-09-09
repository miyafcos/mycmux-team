use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::reducer::{PendingInputKind, PendingOption};
use super::telemetry::{extract_claude, extract_codex, BillableTokens, CodexTotals, TelemetryDelta};
use super::{sha256_hex, unix_ms};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticEventEnvelope {
    pub event_id: String,
    pub source_revision: u64,
    pub occurred_at: i64,
    pub source_byte_start: u64,
    pub source_byte_end: u64,
    pub kind: SemanticEventKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SemanticEventKind {
    UserMessage {
        kind: UserMessageKind,
        text: String,
        digest: String,
    },
    AgentMessage {
        text: String,
    },
    ToolStart {
        call_id: String,
        tool: String,
        target: Option<String>,
    },
    ToolEnd {
        call_id: String,
        tool: String,
        target: Option<String>,
        ok: bool,
        summary: Option<String>,
    },
    Question {
        prompt_event_id: String,
        provider_call_id: String,
        prompt: String,
        kind: PendingInputKind,
        options: Vec<PendingOption>,
    },
    QuestionResolved {
        prompt_event_id: String,
        provider_call_id: String,
    },
    TestResult {
        pass: u32,
        fail: u32,
    },
    FileChange {
        path: String,
        change: String,
    },
    Error {
        fingerprint: String,
        text: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UserMessageKind {
    TaskStart,
    TaskChange,
    Correction,
    Answer,
    Ack,
}

#[derive(Clone, Debug)]
pub struct AgentAdapter {
    kind: String,
    open_questions: HashMap<String, String>,
    open_tools: HashMap<String, (String, Option<String>)>,
    seen_native_ids: HashSet<String>,
    seen_operator_message: bool,
    claude_billed: HashMap<String, BillableTokens>,
    codex_turn_id: Option<String>,
    codex_unpaired_users: Vec<(bool, String)>,
    codex_model: Option<String>,
    codex_effort: Option<String>,
    last_codex_total: Option<CodexTotals>,
    last_telemetry_delta: Option<TelemetryDelta>,
}

impl AgentAdapter {
    /// `claude-codex` writes the very same transcript shape as `claude`, so it
    /// is normalised here instead of being threaded through every decoder.
    pub fn new(kind: &str) -> Result<Self, String> {
        let kind = match kind {
            "claude" | "claude-codex" => "claude",
            "codex" => "codex",
            "grok" => "grok",
            _ => return Err("unsupported agent adapter".to_string()),
        };
        Ok(Self {
            kind: kind.to_string(),
            open_questions: HashMap::new(),
            open_tools: HashMap::new(),
            seen_native_ids: HashSet::new(),
            seen_operator_message: false,
            claude_billed: HashMap::new(),
            codex_turn_id: None,
            codex_unpaired_users: Vec::new(),
            codex_model: None,
            codex_effort: None,
            last_codex_total: None,
            last_telemetry_delta: None,
        })
    }

    pub fn take_telemetry_delta(&mut self) -> Option<TelemetryDelta> {
        self.last_telemetry_delta.take()
    }

    /// Decode one complete JSONL record. Callers must never pass a partial
    /// line; this primitive owns state across record and poll boundaries.
    pub fn decode_record(
        &mut self,
        raw_line: &str,
        byte_range: ByteRange,
        source_revision: u64,
    ) -> Result<Vec<SemanticEventEnvelope>, String> {
        let value: Value = serde_json::from_str(raw_line)
            .map_err(|_| "invalid complete JSONL record".to_string())?;
        let native_id = if self.kind == "grok" {
            grok_native_id(&value, byte_range)
        } else {
            native_id(&value, byte_range)
        };
        if !self.seen_native_ids.insert(native_id.clone()) {
            self.last_telemetry_delta = None;
            return Ok(Vec::new());
        }
        self.last_telemetry_delta = self.extract_telemetry(&value);
        let occurred_at = if self.kind == "grok" {
            grok_timestamp(&value).unwrap_or_else(unix_ms)
        } else {
            value
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_timestamp)
                .unwrap_or_else(unix_ms)
        };
        let mut kinds = match self.kind.as_str() {
            "codex" => self.decode_codex(&value),
            "grok" => self.decode_grok(&value),
            _ => self.decode_claude(&value),
        };
        Ok(kinds
            .drain(..)
            .enumerate()
            .map(|(index, kind)| SemanticEventEnvelope {
                event_id: format!("{native_id}:{index}"),
                source_revision,
                occurred_at,
                source_byte_start: byte_range.start,
                source_byte_end: byte_range.end,
                kind,
            })
            .collect())
    }

    fn extract_telemetry(&mut self, value: &Value) -> Option<TelemetryDelta> {
        match self.kind.as_str() {
            "claude" => extract_claude(value, &mut self.claude_billed),
            "codex" => extract_codex(
                value,
                &mut self.codex_model,
                &mut self.codex_effort,
                &mut self.last_codex_total,
            ),
            _ => None,
        }
    }

    fn decode_codex(&mut self, value: &Value) -> Vec<SemanticEventKind> {
        let payload = value.get("payload").unwrap_or(value);
        let outer = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let inner = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let turn_id = payload.get("turn_id").or_else(|| value.get("turn_id"))
            .and_then(Value::as_str).filter(|id| !id.is_empty());
        if outer == "turn_context" || (outer == "event_msg" && inner == "task_started") {
            self.set_codex_turn(turn_id);
        }
        let is_user = (outer == "event_msg" && inner == "user_message")
            || (outer == "response_item" && inner == "message"
                && payload.get("role").and_then(Value::as_str) == Some("user"));
        if is_user {
            if turn_id.is_some() { self.set_codex_turn(turn_id); }
        } else if (outer == "response_item" && matches!(inner, "message" | "function_call" | "custom_tool_call"))
            || (outer == "event_msg" && inner == "agent_message") {
            // A new input after assistant/tool work is a new occurrence, even
            // when a provider retains the same turn id for steering.
            self.codex_unpaired_users.clear();
        }
        if outer == "event_msg" && matches!(inner, "task_complete" | "turn_aborted") {
            self.set_codex_turn(None);
        }
        match (outer, inner) {
            ("event_msg", "user_message") => payload
                .get("message")
                .and_then(Value::as_str)
                .and_then(|text| self.codex_user_message(text, true))
                .into_iter()
                .collect(),
            ("response_item", "message")
                if payload.get("role").and_then(Value::as_str) == Some("user") =>
            {
                collect_text(payload.get("content"))
                    .and_then(|text| self.codex_user_message(&text, false))
                    .into_iter()
                    .collect()
            }
            ("response_item", "message")
                if payload.get("role").and_then(Value::as_str) == Some("assistant") =>
            {
                collect_text(payload.get("content"))
                    .map(|text| SemanticEventKind::AgentMessage { text })
                    .into_iter()
                    .collect()
            }
            ("response_item", "function_call") | ("response_item", "custom_tool_call") => {
                self.codex_tool_start(payload, inner)
            }
            ("response_item", "function_call_output")
            | ("response_item", "custom_tool_call_output") => self.codex_tool_end(payload),
            _ => Vec::new(),
        }
    }

    fn set_codex_turn(&mut self, turn_id: Option<&str>) {
        if self.codex_turn_id.as_deref() != turn_id || turn_id.is_none() {
            self.codex_turn_id = turn_id.map(str::to_string);
            self.codex_unpaired_users.clear();
        }
    }

    fn codex_user_message(&mut self, text: &str, event_form: bool) -> Option<SemanticEventKind> {
        // Pair two representations once, only inside a proven provider turn.
        // Same-form repeats and all inputs without a turn id remain visible.
        if self.codex_turn_id.is_some() {
            let digest = sha256_hex(text.as_bytes());
            if let Some(index) = self.codex_unpaired_users.iter()
                .position(|(form, seen)| *form != event_form && seen == &digest) {
                self.codex_unpaired_users.remove(index);
                return None;
            }
            self.codex_unpaired_users.push((event_form, digest));
        }
        Some(self.user_message(text))
    }

    fn decode_claude(&mut self, value: &Value) -> Vec<SemanticEventKind> {
        // Sub-agent transcripts share the file with the parent conversation.
        // Folding them in would attribute a sub-agent's prompts and tools to
        // the operator, so the whole record is dropped.
        if value
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Vec::new();
        }
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let message = value.get("message").unwrap_or(value);
        match kind {
            "user" => self.claude_user(value, message),
            "assistant" => self.claude_assistant(message),
            "tool_result" => self.claude_tool_result(value),
            _ => Vec::new(),
        }
    }

    fn decode_grok(&mut self, value: &Value) -> Vec<SemanticEventKind> {
        let update = value.pointer("/params/update").unwrap_or(value);
        match update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "user_message_chunk" => update
                .get("content")
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)
                .map(|text| self.user_message(text))
                .into_iter()
                .collect(),
            "agent_message_chunk" => update
                .get("content")
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)
                .map(|text| SemanticEventKind::AgentMessage {
                    text: text.to_string(),
                })
                .into_iter()
                .collect(),
            "tool_call" => self.grok_tool_start(update),
            "tool_call_update" => self.grok_tool_end(update),
            // Thoughts, hooks, turn completion, and provider-specific records
            // are intentionally not livebrief chat events.
            _ => Vec::new(),
        }
    }

    fn grok_tool_start(&mut self, update: &Value) -> Vec<SemanticEventKind> {
        let call_id = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("missing-call-id")
            .to_string();
        let tool = grok_tool_name(update);
        let target = grok_target(update.get("rawInput"));
        self.open_tools
            .insert(call_id.clone(), (tool.clone(), target.clone()));
        vec![SemanticEventKind::ToolStart {
            call_id,
            tool,
            target,
        }]
    }

    fn grok_tool_end(&mut self, update: &Value) -> Vec<SemanticEventKind> {
        let status = update
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let ok = match status.as_str() {
            "completed" => true,
            "failed" | "error" | "errored" | "cancelled" | "canceled" | "aborted" | "rejected" => {
                false
            }
            // Grok emits status-less progress updates before the terminal
            // update. They are not tool completions.
            _ => return Vec::new(),
        };
        let call_id = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("missing-call-id")
            .to_string();
        let (tool, target) = self
            .open_tools
            .remove(&call_id)
            .unwrap_or_else(|| ("unknown".to_string(), None));
        let summary = grok_summary(update).and_then(|text| short(&text));
        vec![SemanticEventKind::ToolEnd {
            call_id,
            tool,
            target,
            ok,
            summary,
        }]
    }

    /// Claude records tool results as `tool_result` blocks inside a `user`
    /// record, not as a top-level record, so one record can carry both an
    /// operator message and several tool completions.
    fn claude_user(&mut self, record: &Value, message: &Value) -> Vec<SemanticEventKind> {
        let is_meta = record
            .get("isMeta")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut out = Vec::new();
        match message.get("content") {
            Some(Value::Array(blocks)) => {
                let text = blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                if let Some(event) = self.operator_message(&text, is_meta) {
                    out.push(event);
                }
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        out.extend(self.claude_tool_result(block));
                    }
                }
            }
            Some(Value::String(text)) => {
                if let Some(event) = self.operator_message(text, is_meta) {
                    out.push(event);
                }
            }
            _ => {}
        }
        out
    }

    /// `None` when the text is not something the operator typed: meta records,
    /// slash-command scaffolding and injected reminders all reach the
    /// transcript as `user` content.
    fn operator_message(&mut self, text: &str, is_meta: bool) -> Option<SemanticEventKind> {
        if is_meta || text.trim().is_empty() || is_injected_user_text(text) {
            return None;
        }
        Some(self.user_message(text))
    }

    fn codex_tool_start(&mut self, payload: &Value, inner: &str) -> Vec<SemanticEventKind> {
        let call_id = payload
            .get("call_id")
            .and_then(Value::as_str)
            .unwrap_or("missing-call-id")
            .to_string();
        let tool = payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let raw = if inner == "custom_tool_call" {
            payload.get("input").and_then(Value::as_str).unwrap_or("")
        } else {
            payload
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("")
        };
        let target = extract_target(raw);
        self.open_tools
            .insert(call_id.clone(), (tool.clone(), target.clone()));
        if matches!(tool.as_str(), "request_user_input" | "request_permissions") {
            let (prompt, kind, options) = parse_question(raw);
            let prompt_event_id = format!("question:{call_id}");
            self.open_questions
                .insert(call_id.clone(), prompt_event_id.clone());
            vec![SemanticEventKind::Question {
                prompt_event_id,
                provider_call_id: call_id,
                prompt,
                kind,
                options,
            }]
        } else {
            vec![SemanticEventKind::ToolStart {
                call_id,
                tool,
                target,
            }]
        }
    }

    fn codex_tool_end(&mut self, payload: &Value) -> Vec<SemanticEventKind> {
        let call_id = payload
            .get("call_id")
            .and_then(Value::as_str)
            .unwrap_or("missing-call-id")
            .to_string();
        if let Some(prompt_event_id) = self.open_questions.remove(&call_id) {
            return vec![SemanticEventKind::QuestionResolved {
                prompt_event_id,
                provider_call_id: call_id,
            }];
        }
        let (tool, target) = self
            .open_tools
            .remove(&call_id)
            .unwrap_or_else(|| ("unknown".to_string(), None));
        let output = collect_text(payload.get("output")).unwrap_or_default();
        terminal_events(
            call_id,
            tool,
            target,
            !has_nonzero_exit_code(&output),
            &output,
        )
    }

    fn claude_assistant(&mut self, message: &Value) -> Vec<SemanticEventKind> {
        let mut out = Vec::new();
        let contents = message
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for part in contents {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        out.push(SemanticEventKind::AgentMessage {
                            text: text.to_string(),
                        });
                    }
                }
                Some("tool_use") => {
                    let call_id = part
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("missing-call-id")
                        .to_string();
                    let tool = part
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    let raw = part.get("input").map(Value::to_string).unwrap_or_default();
                    let target = extract_target(&raw);
                    self.open_tools
                        .insert(call_id.clone(), (tool.clone(), target.clone()));
                    if matches!(tool.as_str(), "AskUserQuestion" | "ask_user_question") {
                        let (prompt, kind, options) = parse_question(&raw);
                        let prompt_event_id = format!("question:{call_id}");
                        self.open_questions
                            .insert(call_id.clone(), prompt_event_id.clone());
                        out.push(SemanticEventKind::Question {
                            prompt_event_id,
                            provider_call_id: call_id,
                            prompt,
                            kind,
                            options,
                        });
                    } else {
                        out.push(SemanticEventKind::ToolStart {
                            call_id,
                            tool,
                            target,
                        });
                    }
                }
                _ => {}
            }
        }
        out
    }

    fn claude_tool_result(&mut self, value: &Value) -> Vec<SemanticEventKind> {
        let call_id = value
            .get("tool_use_id")
            .or_else(|| value.get("toolUseId"))
            .and_then(Value::as_str)
            .unwrap_or("missing-call-id")
            .to_string();
        if let Some(prompt_event_id) = self.open_questions.remove(&call_id) {
            return vec![SemanticEventKind::QuestionResolved {
                prompt_event_id,
                provider_call_id: call_id,
            }];
        }
        let (tool, target) = self
            .open_tools
            .remove(&call_id)
            .unwrap_or_else(|| ("unknown".to_string(), None));
        let output = collect_text(value.get("content")).unwrap_or_default();
        terminal_events(
            call_id,
            tool,
            target,
            !value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            &output,
        )
    }

    fn user_message(&mut self, text: &str) -> SemanticEventKind {
        let kind = classify_user_message(
            text,
            !self.open_questions.is_empty(),
            self.seen_operator_message,
        );
        self.seen_operator_message = true;
        SemanticEventKind::UserMessage {
            kind,
            text: text.trim().to_string(),
            digest: sha256_hex(normalize(text).as_bytes()),
        }
    }
}

pub fn classify_user_message(
    text: &str,
    has_unresolved_question: bool,
    seen_operator_message: bool,
) -> UserMessageKind {
    let normalized = normalize(text);
    if ["違う", "戻して", "やり直し", "違います"]
        .iter()
        .any(|word| normalized.contains(word))
    {
        return UserMessageKind::Correction;
    }
    if has_unresolved_question {
        return UserMessageKind::Answer;
    }
    if normalized.chars().count() < 20
        && matches!(
            normalized.as_str(),
            "はい" | "ok" | "okay" | "続けて" | "y" | "yes"
        )
    {
        return UserMessageKind::Ack;
    }
    if seen_operator_message {
        UserMessageKind::TaskChange
    } else {
        UserMessageKind::TaskStart
    }
}

pub fn normalize(text: &str) -> String {
    text.trim().to_lowercase()
}

fn native_id(value: &Value, range: ByteRange) -> String {
    value
        .get("uuid")
        .or_else(|| value.get("id"))
        .or_else(|| value.pointer("/payload/id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}:{}", range.start, range.end))
}

fn grok_native_id(value: &Value, range: ByteRange) -> String {
    value
        .pointer("/params/_meta/eventId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| native_id(value, range))
}

fn grok_timestamp(value: &Value) -> Option<i64> {
    value
        .pointer("/params/_meta/agentTimestampMs")
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("timestamp")
                .and_then(Value::as_i64)
                .and_then(|seconds| seconds.checked_mul(1000))
        })
}

fn grok_tool_name(update: &Value) -> String {
    update
        .get("_meta")
        .and_then(|meta| meta.get("x.ai/tool"))
        .and_then(|tool| tool.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            update
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
        })
        .or_else(|| {
            update
                .get("kind")
                .and_then(Value::as_str)
                .filter(|kind| !kind.trim().is_empty())
        })
        .unwrap_or("unknown")
        .to_string()
}

fn grok_target(raw_input: Option<&Value>) -> Option<String> {
    let raw_input = raw_input?;
    if let Value::String(raw) = raw_input {
        return extract_target(raw);
    }
    [
        "file_path",
        "target_file",
        "path",
        "notebook_path",
        "target_directory",
        "command",
        "query",
        "url",
    ]
    .iter()
    .find_map(|key| raw_input.get(*key).and_then(Value::as_str))
    .map(str::to_string)
}

fn grok_summary(update: &Value) -> Option<String> {
    update
        .get("rawOutput")
        .and_then(grok_text)
        .or_else(|| update.get("content").and_then(grok_text))
}

fn grok_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.to_string()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(grok_text)
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        Value::Object(map) => [
            "text",
            "content_concise",
            "content",
            "output",
            "message",
            "FileContent",
            "raw_output",
        ]
        .iter()
        .find_map(|key| map.get(*key).and_then(grok_text)),
        _ => None,
    }
}

fn collect_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.trim().is_empty() => Some(text.to_string()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        Value::Object(map) => map.get("text").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

fn extract_target(raw: &str) -> Option<String> {
    serde_json::from_str::<Value>(raw).ok().and_then(|value| {
        value
            .get("file_path")
            .or_else(|| value.get("path"))
            .or_else(|| value.get("notebook_path"))
            .or_else(|| value.get("command"))
            .or_else(|| value.get("query"))
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn terminal_events(
    call_id: String,
    tool: String,
    target: Option<String>,
    ok: bool,
    output: &str,
) -> Vec<SemanticEventKind> {
    let summary = short(output);
    let mut events = vec![SemanticEventKind::ToolEnd {
        call_id,
        tool: tool.clone(),
        target: target.clone(),
        ok,
        summary: summary.clone(),
    }];
    if ok {
        if let Some((path, change)) = file_change(&tool, target.as_deref()) {
            events.push(SemanticEventKind::FileChange { path, change });
        }
    }
    if is_test_command_tool(&tool) {
        for (pass, fail) in explicit_test_results(output) {
            events.push(SemanticEventKind::TestResult { pass, fail });
        }
    }
    if !ok {
        let detail = clear_error_line(output)
            .map(str::to_string)
            .or(summary)
            .unwrap_or_else(|| "failed".to_string());
        let text = format!("{tool}: {detail}");
        events.push(SemanticEventKind::Error {
            fingerprint: sha256_hex(normalize(&text).as_bytes()),
            text,
        });
    }
    events
}

/// Only tool names observed in the pre-change real-log measurement are
/// admitted. A success does not imply a write for any other tool name.
fn file_change(tool: &str, target: Option<&str>) -> Option<(String, String)> {
    let path = target?.trim();
    if path.is_empty() {
        return None;
    }
    match tool {
        "Edit" => Some((path.to_string(), "modified".to_string())),
        "Write" => Some((path.to_string(), "written".to_string())),
        _ => None,
    }
}

/// Only command runner names observed in the pre-change real-log measurement
/// are considered. TestResult never follows a tool name alone; a recognised
/// explicit result line is also required.
fn is_test_command_tool(tool: &str) -> bool {
    matches!(tool, "Bash" | "PowerShell" | "exec")
}

fn explicit_test_results(output: &str) -> Vec<(u32, u32)> {
    output
        .lines()
        .filter_map(parse_explicit_test_result)
        .collect()
}

/// Accept only complete summary forms seen in real logs: cargo's `test
/// result`, Vitest's `Tests N passed (N)`, and pytest's `= N passed in ... =`.
fn parse_explicit_test_result(line: &str) -> Option<(u32, u32)> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("test result: ") {
        let pass = count_before_marker(rest, " passed;")?;
        let fail = count_before_marker(rest, " failed;").unwrap_or(0);
        return Some((pass, fail));
    }
    if let Some(rest) = line.strip_prefix("Tests") {
        let pass = first_number(rest)?;
        if rest.contains(" passed (") {
            return Some((pass, 0));
        }
    }
    if line.starts_with('=') && line.ends_with('=') && line.contains(" passed in ") {
        let pass = count_before_marker(line, " passed in")?;
        let fail = count_before_marker(line, " failed,").unwrap_or(0);
        return Some((pass, fail));
    }
    None
}

fn count_before_marker(text: &str, marker: &str) -> Option<u32> {
    let prefix = text.split_once(marker)?.0;
    prefix.split_whitespace().last()?.parse::<u32>().ok()
}

fn first_number(text: &str) -> Option<u32> {
    text.split_whitespace()
        .find_map(|word| word.parse::<u32>().ok())
}

fn has_nonzero_exit_code(output: &str) -> bool {
    output.lines().any(|line| {
        line.trim()
            .strip_prefix("Exit code:")
            .and_then(|code| code.trim().parse::<i32>().ok())
            .is_some_and(|code| code != 0)
    })
}

fn clear_error_line(output: &str) -> Option<&str> {
    output.lines().map(str::trim).find(|line| {
        line.starts_with("error:")
            || line.starts_with("error[")
            || line.starts_with("FAILED")
            || line.starts_with("Traceback")
    })
}

fn parse_question(raw: &str) -> (String, PendingInputKind, Vec<PendingOption>) {
    let value = serde_json::from_str::<Value>(raw).unwrap_or(Value::Null);
    let prompt = value
        .get("question")
        .or_else(|| value.get("prompt"))
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("Input required")
        .to_string();
    let options: Vec<PendingOption> = value
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    let label = item
                        .get("label")
                        .or_else(|| item.get("text"))
                        .and_then(Value::as_str)
                        .or_else(|| item.as_str())?;
                    let payload = item
                        .get("value")
                        .or_else(|| item.get("payload"))
                        .and_then(Value::as_str)
                        .unwrap_or(label);
                    Some(PendingOption::new(
                        format!("option-{index}"),
                        label.to_string(),
                        payload.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let kind = if options.is_empty() {
        PendingInputKind::FreeText
    } else {
        PendingInputKind::Choice
    };
    (prompt, kind, options)
}

/// Text the CLI injects into the `user` role on the operator's behalf.
const INJECTED_USER_PREFIXES: [&str; 4] = [
    "<command-name>",
    "<command-message>",
    "<local-command-stdout>",
    "<system-reminder>",
];

fn is_injected_user_text(text: &str) -> bool {
    let text = text.trim_start();
    INJECTED_USER_PREFIXES
        .iter()
        .any(|prefix| text.starts_with(prefix))
}

fn short(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(160).collect())
}

fn parse_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn answer_beats_short_ack_when_a_question_is_open() {
        assert_eq!(
            classify_user_message("y", true, true),
            UserMessageKind::Answer
        );
    }
    #[test]
    fn correction_beats_answer() {
        assert_eq!(
            classify_user_message("違う", true, true),
            UserMessageKind::Correction
        );
    }
    fn decode(adapter: &mut AgentAdapter, line: &str) -> Vec<SemanticEventKind> {
        adapter
            .decode_record(line, ByteRange { start: 0, end: 1 }, 1)
            .unwrap()
            .into_iter()
            .map(|envelope| envelope.kind)
            .collect()
    }

    fn codex_records(records: Vec<Value>) -> Vec<SemanticEventEnvelope> {
        let mut adapter = AgentAdapter::new("codex").unwrap();
        records.into_iter().enumerate().flat_map(|(i, record)| {
            adapter.decode_record(&record.to_string(), ByteRange { start: i as u64, end: i as u64 + 1 }, 1).unwrap()
        }).collect()
    }

    fn codex_input(event_form: bool, turn: Option<&str>, timestamp: &str) -> Value {
        let mut value = if event_form {
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"repeat this task"}})
        } else {
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"repeat this task"}]}})
        };
        value["timestamp"] = serde_json::json!(timestamp);
        if let Some(turn) = turn { value["payload"]["turn_id"] = serde_json::json!(turn); }
        value
    }

    #[test]
    fn codex_pairs_both_user_formats_once_per_provider_turn_in_either_order() {
        for reverse in [false, true] {
            let first = codex_input(reverse, None, "2026-09-08T15:42:18.547Z");
            let second = codex_input(!reverse, None, "2026-09-08T15:42:18.548Z");
            let events = codex_records(vec![
                serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}),
                first.clone(),
                serde_json::json!({"type":"turn_context","payload":{"turn_id":"turn-1"}}),
                second.clone(),
                first, second,
            ]);
            assert_eq!(events.len(), 2, "two genuine submissions, each represented twice");
            assert!(events.iter().all(|event| matches!(event.kind, SemanticEventKind::UserMessage { .. })));
        }
    }

    #[test]
    fn codex_preserves_reinputs_across_turns_missing_turns_and_same_format() {
        assert_eq!(codex_records(vec![
            codex_input(false, Some("one"), "2026-09-08T00:00:00Z"),
            codex_input(true, Some("two"), "2026-09-08T00:00:00Z"),
        ]).len(), 2);
        assert_eq!(codex_records(vec![
            codex_input(false, None, "2026-09-08T00:00:00Z"),
            codex_input(true, None, "2026-09-08T00:00:00Z"),
        ]).len(), 2);
        assert_eq!(codex_records(vec![
            codex_input(false, Some("one"), "2026-09-08T00:00:00Z"),
            codex_input(false, Some("one"), "2026-09-08T00:00:01Z"),
        ]).len(), 2);
        for boundary in [
            serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"one"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}),
        ] {
            assert_eq!(codex_records(vec![
                codex_input(false, Some("one"), "2026-09-08T00:00:00Z"), boundary,
                codex_input(true, None, "2026-09-08T00:00:01Z"),
            ]).len(), 2);
        }
    }

    fn grok_line(event_id: &str, timestamp_ms: i64, update: serde_json::Value) -> String {
        serde_json::json!({
            "timestamp": timestamp_ms / 1000,
            "method": "session/update",
            "params": {
                "sessionId": "grok-session",
                "update": update,
                "_meta": {
                    "eventId": event_id,
                    "agentTimestampMs": timestamp_ms
                }
            }
        })
        .to_string()
    }

    #[test]
    fn grok_accepts_user_and_agent_messages_without_concatenating_chunks() {
        let mut adapter = AgentAdapter::new("grok").unwrap();
        let user = decode(
            &mut adapter,
            &grok_line(
                "grok-user-1",
                1_700_000_000_123,
                serde_json::json!({
                    "sessionUpdate": "user_message_chunk",
                    "content": {"type": "text", "text": "start this task"}
                }),
            ),
        );
        assert!(matches!(
            &user[0],
            SemanticEventKind::UserMessage {
                kind: UserMessageKind::TaskStart,
                text,
                ..
            } if text == "start this task"
        ));

        let agent = decode(
            &mut adapter,
            &grok_line(
                "grok-agent-1",
                1_700_000_000_456,
                serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "first chunk"}
                }),
            ),
        );
        assert!(matches!(
            &agent[0],
            SemanticEventKind::AgentMessage { text } if text == "first chunk"
        ));
    }

    #[test]
    fn grok_tool_end_inherits_tool_and_target_from_tool_call() {
        let mut adapter = AgentAdapter::new("grok").unwrap();
        let started = decode(
            &mut adapter,
            &grok_line(
                "grok-tool-start",
                1_700_000_001_000,
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "grok-call-1",
                    "title": "Read",
                    "kind": "read",
                    "status": "in_progress",
                    "rawInput": {"target_file": "src/lib.rs"}
                }),
            ),
        );
        assert!(matches!(
            &started[0],
            SemanticEventKind::ToolStart { tool, target, .. }
                if tool == "Read" && target.as_deref() == Some("src/lib.rs")
        ));

        let ended = decode(
            &mut adapter,
            &grok_line(
                "grok-tool-end",
                1_700_000_001_500,
                serde_json::json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "grok-call-1",
                    "status": "completed",
                    "rawOutput": "file body"
                }),
            ),
        );
        assert!(matches!(
            &ended[0],
            SemanticEventKind::ToolEnd {
                call_id,
                tool,
                target,
                ok: true,
                summary,
            } if call_id == "grok-call-1"
                && tool == "Read"
                && target.as_deref() == Some("src/lib.rs")
                && summary.as_deref() == Some("file body")
        ));
    }

    #[test]
    fn grok_failed_tool_update_is_not_ok() {
        let mut adapter = AgentAdapter::new("grok").unwrap();
        decode(
            &mut adapter,
            &grok_line(
                "grok-failed-start",
                1_700_000_002_000,
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "grok-call-failed",
                    "title": "Execute",
                    "rawInput": {"command": "cargo test"}
                }),
            ),
        );
        let ended = decode(
            &mut adapter,
            &grok_line(
                "grok-failed-end",
                1_700_000_002_500,
                serde_json::json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "grok-call-failed",
                    "status": "failed",
                    "rawOutput": "permission denied"
                }),
            ),
        );
        assert!(matches!(
            &ended[0],
            SemanticEventKind::ToolEnd { ok: false, .. }
        ));
    }

    #[test]
    fn grok_ignores_thought_hook_and_nonterminal_tool_updates() {
        let mut adapter = AgentAdapter::new("grok").unwrap();
        for (event_id, update) in [
            (
                "grok-thought",
                serde_json::json!({
                    "sessionUpdate": "agent_thought_chunk",
                    "content": {"type": "text", "text": "hidden"}
                }),
            ),
            (
                "grok-hook",
                serde_json::json!({
                    "sessionUpdate": "hook_execution",
                    "event_name": "session_start"
                }),
            ),
            (
                "grok-turn",
                serde_json::json!({
                    "sessionUpdate": "turn_completed",
                    "stop_reason": "end_turn"
                }),
            ),
        ] {
            assert!(decode(
                &mut adapter,
                &grok_line(event_id, 1_700_000_003_000, update)
            )
            .is_empty());
        }

        decode(
            &mut adapter,
            &grok_line(
                "grok-progress-start",
                1_700_000_003_500,
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "grok-progress",
                    "title": "Read",
                    "rawInput": {"target_file": "src/lib.rs"}
                }),
            ),
        );
        let progress = decode(
            &mut adapter,
            &grok_line(
                "grok-progress-update",
                1_700_000_003_600,
                serde_json::json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "grok-progress",
                    "title": "Read",
                    "kind": "read"
                }),
            ),
        );
        assert!(progress.is_empty());
    }

    #[test]
    fn grok_uses_event_id_for_deduplication_and_agent_timestamp_for_occurrence() {
        let mut adapter = AgentAdapter::new("grok").unwrap();
        let line = grok_line(
            "grok-duplicate",
            1_700_000_004_123,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "one"}
            }),
        );
        let first = adapter
            .decode_record(&line, ByteRange { start: 0, end: 10 }, 7)
            .unwrap();
        let duplicate = adapter
            .decode_record(&line, ByteRange { start: 10, end: 20 }, 8)
            .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].event_id, "grok-duplicate:0");
        assert_eq!(first[0].occurred_at, 1_700_000_004_123);
        assert!(duplicate.is_empty());
    }

    #[test]
    fn claude_tool_result_block_inside_a_user_record_ends_the_call() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let events = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"tool_use_id":"toolu_x","type":"tool_result","content":"ok"}]}}"#,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            SemanticEventKind::ToolEnd {
                call_id,
                ok,
                summary,
                ..
            } => {
                assert_eq!(call_id, "toolu_x");
                assert!(ok);
                assert_eq!(summary.as_deref(), Some("ok"));
            }
            other => panic!("expected a toolEnd, got {other:?}"),
        }
    }

    #[test]
    fn claude_tool_end_inherits_the_tool_and_target_of_its_tool_use() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let started = decode(
            &mut adapter,
            r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_x","name":"Read","input":{"path":"src/lib.rs"}}]}}"#,
        );
        assert!(matches!(&started[0], SemanticEventKind::ToolStart { tool, .. } if tool == "Read"));
        let ended = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"tool_use_id":"toolu_x","type":"tool_result","content":[{"type":"text","text":"file body"}]}]}}"#,
        );
        match &ended[0] {
            SemanticEventKind::ToolEnd {
                tool,
                target,
                summary,
                ..
            } => {
                assert_eq!(tool, "Read");
                assert_eq!(target.as_deref(), Some("src/lib.rs"));
                assert_eq!(summary.as_deref(), Some("file body"));
            }
            other => panic!("expected a toolEnd, got {other:?}"),
        }
    }

    #[test]
    fn claude_tool_result_error_flag_marks_the_call_failed() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let events = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"u3","message":{"role":"user","content":[{"tool_use_id":"toolu_y","type":"tool_result","is_error":true,"content":"boom"}]}}"#,
        );
        assert!(matches!(
            &events[0],
            SemanticEventKind::ToolEnd { ok: false, .. }
        ));
    }

    #[test]
    fn successful_edit_with_file_path_emits_file_change_after_tool_end() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let started = decode(
            &mut adapter,
            r#"{"type":"assistant","uuid":"e1","message":{"role":"assistant","content":[{"type":"tool_use","id":"edit-1","name":"Edit","input":{"file_path":"src/live.rs","old_string":"old","new_string":"new"}}]}}"#,
        );
        assert!(
            matches!(&started[0], SemanticEventKind::ToolStart { target, .. } if target.as_deref() == Some("src/live.rs"))
        );
        let ended = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"e2","message":{"role":"user","content":[{"tool_use_id":"edit-1","type":"tool_result","content":"Done"}]}}"#,
        );
        assert!(matches!(
            &ended[0],
            SemanticEventKind::ToolEnd { ok: true, .. }
        ));
        assert!(
            matches!(&ended[1], SemanticEventKind::FileChange { path, change } if path == "src/live.rs" && change == "modified")
        );
    }

    #[test]
    fn failed_edit_emits_error_but_not_file_change() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        decode(
            &mut adapter,
            r#"{"type":"assistant","uuid":"f1","message":{"role":"assistant","content":[{"type":"tool_use","id":"edit-2","name":"Edit","input":{"file_path":"src/live.rs"}}]}}"#,
        );
        let ended = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"f2","message":{"role":"user","content":[{"tool_use_id":"edit-2","type":"tool_result","is_error":true,"content":"permission denied"}]}}"#,
        );
        assert!(matches!(
            &ended[0],
            SemanticEventKind::ToolEnd { ok: false, .. }
        ));
        assert!(
            matches!(&ended[1], SemanticEventKind::Error { text, .. } if text == "Edit: permission denied")
        );
        assert!(!ended
            .iter()
            .any(|event| matches!(event, SemanticEventKind::FileChange { .. })));
    }

    #[test]
    fn explicit_cargo_result_emits_test_result_after_tool_end() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        decode(
            &mut adapter,
            r#"{"type":"assistant","uuid":"t1","message":{"role":"assistant","content":[{"type":"tool_use","id":"bash-1","name":"Bash","input":{"command":"cargo test"}}]}}"#,
        );
        let ended = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"t2","message":{"role":"user","content":[{"tool_use_id":"bash-1","type":"tool_result","content":"test result: ok. 12 passed; 0 failed; 0 ignored;"}]}}"#,
        );
        assert!(matches!(
            &ended[0],
            SemanticEventKind::ToolEnd { ok: true, .. }
        ));
        assert!(matches!(
            &ended[1],
            SemanticEventKind::TestResult { pass: 12, fail: 0 }
        ));
    }

    #[test]
    fn test_named_command_without_explicit_counts_emits_no_test_result() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        decode(
            &mut adapter,
            r#"{"type":"assistant","uuid":"nt1","message":{"role":"assistant","content":[{"type":"tool_use","id":"bash-2","name":"Bash","input":{"command":"cargo test"}}]}}"#,
        );
        let ended = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"nt2","message":{"role":"user","content":[{"tool_use_id":"bash-2","type":"tool_result","content":"tests are running"}]}}"#,
        );
        assert_eq!(ended.len(), 1);
        assert!(matches!(&ended[0], SemanticEventKind::ToolEnd { .. }));
    }

    #[test]
    fn successful_error_lookalike_emits_no_error() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        decode(
            &mut adapter,
            r#"{"type":"assistant","uuid":"se1","message":{"role":"assistant","content":[{"type":"tool_use","id":"bash-3","name":"Bash","input":{"command":"printf error"}}]}}"#,
        );
        let ended = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"se2","message":{"role":"user","content":[{"tool_use_id":"bash-3","type":"tool_result","content":"error: this string is expected output"}]}}"#,
        );
        assert_eq!(ended.len(), 1);
        assert!(matches!(
            &ended[0],
            SemanticEventKind::ToolEnd { ok: true, .. }
        ));
    }

    #[test]
    fn codex_nonzero_exit_code_emits_error() {
        let mut adapter = AgentAdapter::new("codex").unwrap();
        let started = adapter.decode_record(r#"{"type":"response_item","payload":{"type":"function_call","call_id":"exec-1","name":"exec","arguments":"{\"command\":\"cargo test\"}"}}"#, ByteRange { start: 0, end: 1 }, 1).unwrap();
        assert!(matches!(
            started[0].kind,
            SemanticEventKind::ToolStart { .. }
        ));
        let ended = adapter.decode_record(r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"exec-1","output":"Exit code: 2\nerror: failed"}}"#, ByteRange { start: 1, end: 2 }, 2).unwrap();
        assert!(matches!(
            &ended[0].kind,
            SemanticEventKind::ToolEnd { ok: false, .. }
        ));
        assert!(
            matches!(&ended[1].kind, SemanticEventKind::Error { text, .. } if text == "exec: error: failed")
        );
    }

    #[test]
    fn injected_user_records_never_become_operator_messages() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let meta = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"n1","isMeta":true,"message":{"role":"user","content":"Caveat: the messages below were generated"}}"#,
        );
        assert!(meta.is_empty(), "isMeta record produced {meta:?}");
        let command = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"n2","message":{"role":"user","content":[{"type":"text","text":"<command-name>junbi</command-name>"}]}}"#,
        );
        assert!(
            command.is_empty(),
            "slash-command scaffolding produced {command:?}"
        );
        let reminder = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"n3","message":{"role":"user","content":"<system-reminder>do not mention this</system-reminder>"}}"#,
        );
        assert!(reminder.is_empty(), "system reminder produced {reminder:?}");
        let stdout = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"n4","message":{"role":"user","content":"<local-command-stdout>done</local-command-stdout>"}}"#,
        );
        assert!(
            stdout.is_empty(),
            "local command output produced {stdout:?}"
        );
    }

    #[test]
    fn sidechain_records_contribute_neither_messages_nor_tool_events() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let prompt = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"s1","isSidechain":true,"message":{"role":"user","content":[{"type":"text","text":"sub-agent task"}]}}"#,
        );
        assert!(prompt.is_empty(), "sidechain prompt produced {prompt:?}");
        let tool_use = decode(
            &mut adapter,
            r#"{"type":"assistant","uuid":"s2","isSidechain":true,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_s","name":"Grep","input":{"path":"x"}}]}}"#,
        );
        assert!(
            tool_use.is_empty(),
            "sidechain tool_use produced {tool_use:?}"
        );
        let tool_result = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"s3","isSidechain":true,"message":{"role":"user","content":[{"tool_use_id":"toolu_s","type":"tool_result","content":"ok"}]}}"#,
        );
        assert!(
            tool_result.is_empty(),
            "sidechain tool_result produced {tool_result:?}"
        );
    }

    #[test]
    fn a_user_record_carrying_both_text_and_a_tool_result_emits_both() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let events = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"u5","message":{"role":"user","content":[{"type":"text","text":"keep going"},{"tool_use_id":"toolu_z","type":"tool_result","content":"ok"}]}}"#,
        );
        assert_eq!(events.len(), 2);
        assert!(
            matches!(&events[0], SemanticEventKind::UserMessage { text, .. } if text == "keep going")
        );
        assert!(
            matches!(&events[1], SemanticEventKind::ToolEnd { call_id, .. } if call_id == "toolu_z")
        );
    }

    #[test]
    fn claude_codex_decodes_with_the_claude_transcript_shape() {
        let mut adapter = AgentAdapter::new("claude-codex").unwrap();
        let events = decode(
            &mut adapter,
            r#"{"type":"user","uuid":"cc1","message":{"role":"user","content":[{"type":"text","text":"build it"},{"tool_use_id":"toolu_c","type":"tool_result","content":"ok"}]}}"#,
        );
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            SemanticEventKind::UserMessage {
                kind: UserMessageKind::TaskStart,
                ..
            }
        ));
        assert!(
            matches!(&events[1], SemanticEventKind::ToolEnd { call_id, .. } if call_id == "toolu_c")
        );
    }

    #[test]
    fn codex_question_tracks_call_id_across_records() {
        let mut adapter = AgentAdapter::new("codex").unwrap();
        let start = adapter.decode_record(r#"{"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"function_call","call_id":"c1","name":"request_user_input","arguments":"{\"question\":\"go?\",\"options\":[\"yes\"]}"}}"#, ByteRange { start: 0, end: 1 }, 1).unwrap();
        assert!(matches!(start[0].kind, SemanticEventKind::Question { .. }));
        let end = adapter.decode_record(r#"{"type":"response_item","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}"#, ByteRange { start: 1, end: 2 }, 2).unwrap();
        assert!(matches!(
            end[0].kind,
            SemanticEventKind::QuestionResolved { .. }
        ));
    }

    #[test]
    fn claude_assistant_usage_is_exposed_as_telemetry() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let _ = decode(
            &mut adapter,
            r#"{"type":"assistant","requestId":"req_1","effort":"high","uuid":"u1","message":{"id":"m1","model":"claude-sonnet-4-6","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":2,"output_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500}}}"#,
        );
        let delta = adapter.take_telemetry_delta().expect("telemetry");
        assert_eq!(delta.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(delta.effort.as_deref(), Some("high"));
        assert_eq!(delta.occupancy_tokens, Some(1502));
        assert_eq!(delta.turn_inc, 1);
    }

    #[test]
    fn codex_token_count_is_exposed_as_telemetry_without_a_chat_event() {
        let mut adapter = AgentAdapter::new("codex").unwrap();
        let _ = adapter
            .decode_record(
                r#"{"type":"turn_context","payload":{"model":"gpt-5.5","effort":"high"}}"#,
                ByteRange { start: 0, end: 80 },
                1,
            )
            .unwrap();
        let _ = adapter.take_telemetry_delta();
        let events = adapter
            .decode_record(
                r#"{"timestamp":"2026-08-04T00:00:02.000Z","ordinal":1,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"total_tokens":1100},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"cache_write_input_tokens":0,"output_tokens":100,"total_tokens":1100}}}}"#,
                ByteRange { start: 81, end: 400 },
                2,
            )
            .unwrap();
        assert!(events.is_empty());
        let delta = adapter.take_telemetry_delta().expect("telemetry");
        assert_eq!(delta.occupancy_tokens, Some(1100));
        assert_eq!(delta.turn_inc, 1);
        assert_eq!(delta.model.as_deref(), Some("gpt-5.5"));
    }
}
