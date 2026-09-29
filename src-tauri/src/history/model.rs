use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::livebrief::SemanticEventEnvelope;

#[derive(Clone, Debug)]
pub(crate) struct JournalEvent {
    pub envelope: SemanticEventEnvelope,
    pub source_hash: String,
}

impl JournalEvent {
    pub(crate) fn from_raw_line(envelope: SemanticEventEnvelope, raw_line: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"history-source-hash-v1\0");
        hasher.update((raw_line.len() as u64).to_be_bytes());
        hasher.update(raw_line.as_bytes());
        hasher.update((envelope.event_id.len() as u64).to_be_bytes());
        hasher.update(envelope.event_id.as_bytes());
        Self {
            envelope,
            source_hash: format!("{:x}", hasher.finalize()),
        }
    }
}

pub(crate) struct IngestInput<'a> {
    /// This is currently the stable agent session identifier approved by amend-1.
    pub logical_session_id: &'a str,
    pub agent_session_id: &'a str,
    pub agent_kind: &'a str,
    /// Diagnostic only; it is never used to group events.
    pub pty_session_id: &'a str,
    pub repo_id: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub branch: Option<&'a str>,
    pub source_log: &'a Path,
    pub events: &'a [JournalEvent],
}

/// Observable work performed by one ingest call.  This stays internal so
/// history can prove that a repeated full transcript does no event work.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct IngestStats {
    pub new_event_count: usize,
    pub event_insert_attempts: usize,
    pub event_inserts: usize,
    pub capsule_events_read: usize,
    pub capsule_rebuild_count: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SearchFilters {
    pub repo_id: Option<String>,
    pub branch: Option<String>,
    pub logical_session_id: Option<String>,
    pub near_timestamp: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Hit {
    pub event_id: String,
    pub logical_session_id: String,
    pub timestamp: i64,
    pub event_type: String,
    pub searchable_text: String,
    pub repo_id: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub bm25_score: Option<f64>,
}

#[derive(Clone, Debug)]
pub(crate) struct StoredEvent {
    pub event_id: String,
    pub timestamp: i64,
    pub payload_json: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum CapsuleState {
    Open,
    Closed,
}

impl CapsuleState {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TestResult {
    pub pass: u64,
    pub fail: u64,
    pub evidence_event_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SemanticFields {
    pub decisions: Vec<String>,
    pub assumptions: Vec<String>,
    pub open_questions: Vec<String>,
    pub next_actions: Vec<String>,
    pub derived_by: Option<String>,
    pub evidence_event_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct MachineTurnCapsule {
    pub turn_id: String,
    pub logical_session_id: String,
    pub source_log: String,
    pub opened_by_event_id: String,
    pub closed_by_event_id: Option<String>,
    pub state: CapsuleState,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub read_files: Vec<String>,
    pub written_files: Vec<String>,
    pub commands: Vec<String>,
    pub test_results: Vec<TestResult>,
    pub errors: Vec<String>,
    pub evidence_event_ids: Vec<String>,
    pub semantic: SemanticFields,
}

#[derive(Debug)]
pub(crate) enum HistoryError {
    Database(String),
    Runtime(String),
    Serialization(String),
}

impl std::fmt::Display for HistoryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(message) | Self::Runtime(message) | Self::Serialization(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl std::error::Error for HistoryError {}

impl From<rusqlite::Error> for HistoryError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error.to_string())
    }
}

pub(crate) fn event_type(envelope: &SemanticEventEnvelope) -> Result<String, HistoryError> {
    let value = event_value(envelope)?;
    Ok(value
        .pointer("/kind/type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string())
}

pub(crate) fn searchable_text(envelope: &SemanticEventEnvelope) -> Result<String, HistoryError> {
    let value = event_value(envelope)?;
    let kind = value.get("kind").and_then(Value::as_object);
    let event_type = kind
        .and_then(|kind| kind.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let text = match event_type {
        "userMessage" | "agentMessage" | "error" => kind
            .and_then(|kind| kind.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        "toolStart" | "toolEnd" => {
            let tool = kind
                .and_then(|kind| kind.get("tool"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let target = kind
                .and_then(|kind| kind.get("target"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            [tool, target]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        }
        "testResult" => {
            let pass = kind
                .and_then(|kind| kind.get("pass"))
                .and_then(Value::as_u64)
                .unwrap_or_default();
            let fail = kind
                .and_then(|kind| kind.get("fail"))
                .and_then(Value::as_u64)
                .unwrap_or_default();
            format!("pass {pass} fail {fail}")
        }
        "fileChange" => kind
            .and_then(|kind| kind.get("path"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    };
    Ok(text)
}

pub(crate) fn payload_json(envelope: &SemanticEventEnvelope) -> Result<Vec<u8>, HistoryError> {
    serde_json::to_vec(envelope).map_err(|error| HistoryError::Serialization(error.to_string()))
}

pub(crate) fn event_value(envelope: &SemanticEventEnvelope) -> Result<Value, HistoryError> {
    serde_json::to_value(envelope).map_err(|error| HistoryError::Serialization(error.to_string()))
}

pub(crate) fn event_index(event_id: &str) -> i64 {
    event_id
        .rsplit_once(':')
        .and_then(|(_, index)| index.parse::<i64>().ok())
        .unwrap_or_default()
}
