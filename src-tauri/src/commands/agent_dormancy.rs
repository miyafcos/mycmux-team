//! A durable conversation receipt before stopping a completed agent process.
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::livebrief::LiveSessionEvents;
use crate::AppState;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DormancyRecordReceipt {
    pub pty_session_id: String,
    pub agent_kind: String,
    pub agent_session_id: String,
    pub pty_generation: u64,
    pub saved_at: u64,
    pub bytes: u64,
}

fn record_path(root: &Path, kind: &str, session_id: &str) -> Result<PathBuf, String> {
    if !matches!(kind, "claude" | "codex") {
        return Err("Unsupported dormant agent kind".into());
    }
    uuid::Uuid::parse_str(session_id).map_err(|_| "Invalid dormant conversation id".to_string())?;
    Ok(root.join("dormancy-records").join(kind).join(format!("{session_id}.jsonl")))
}

fn save_record(source: &Path, target: &Path, kind: &str, session_id: &str, pty: &str, generation: u64) -> Result<DormancyRecordReceipt, String> {
    let before = fs::metadata(source).map_err(|error| format!("Cannot inspect conversation record: {error}"))?;
    if before.len() == 0 { return Err("Conversation record is empty".into()); }
    // Do not accept a torn last reply as evidence that the completed turn was saved.
    let reader = BufReader::new(fs::File::open(source).map_err(|error| error.to_string())?);
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        if !line.trim().is_empty() && serde_json::from_str::<serde_json::Value>(&line).is_err() {
            return Err("Conversation record contains an incomplete JSONL record".into());
        }
    }
    crate::livebrief::read_dormancy_record_events(source, kind, session_id, pty, true)?;
    // The existing savepoint writer streams complete JSONL and flushes + fsyncs
    // before its atomic rename. Never mistake best-effort history ingest for this.
    crate::agent_transcript::copy_claude_transcript(source, target)?;
    let after = fs::metadata(source).map_err(|error| error.to_string())?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("Conversation changed while its record was being saved".into());
    }
    let bytes = fs::metadata(target).map_err(|error| error.to_string())?.len();
    if bytes == 0 { return Err("Saved conversation record is empty".into()); }
    Ok(DormancyRecordReceipt {
        pty_session_id: pty.into(), agent_kind: kind.into(), agent_session_id: session_id.into(),
        pty_generation: generation, saved_at: crate::session_state::unix_epoch_millis(), bytes,
    })
}

#[tauri::command(async)]
pub async fn save_agent_dormancy_record(app: AppHandle, state: State<'_, AppState>, pty_session_id: String, agent_kind: String, agent_session_id: String) -> Result<DormancyRecordReceipt, String> {
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let target = record_path(&root, &agent_kind, &agent_session_id)?;
    let manager = state.session_manager.clone();
    let statuses = state.session_state_store.clone();
    crate::util::task::run_blocking("save_agent_dormancy_record", move || {
        let identity = manager.trusted_agent_identity(&pty_session_id).ok_or("Conversation identity is unconfirmed")?;
        if identity.kind != agent_kind || identity.session_id != agent_session_id {
            return Err("Conversation identity changed".into());
        }
        let (generation, _) = manager.session_observation(&pty_session_id).ok_or("Agent process is unavailable")?;
        if statuses.current_view(&pty_session_id).is_some_and(|view| {
            !matches!(view.attention.kind, crate::session_state::AttentionKind::None | crate::session_state::AttentionKind::Done)
        }) { return Err("Conversation needs attention".into()); }
        let source = crate::livebrief::locate_transcript_cached(&agent_kind, &agent_session_id).ok_or("Conversation record was not found")?;
        let receipt = save_record(&source, &target, &agent_kind, &agent_session_id, &pty_session_id, generation)?;
        if manager.session_observation(&pty_session_id).map(|value| value.0) != Some(generation)
            || manager.trusted_agent_identity(&pty_session_id).is_none_or(|value| value.kind != agent_kind || value.session_id != agent_session_id) {
            return Err("Agent process changed while saving its record".into());
        }
        Ok(receipt)
    }).await
}

#[tauri::command(async)]
pub async fn get_agent_dormancy_record(app: AppHandle, pty_session_id: String, agent_kind: String, agent_session_id: String) -> Result<LiveSessionEvents, String> {
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let path = record_path(&root, &agent_kind, &agent_session_id)?;
    crate::util::task::run_blocking("get_agent_dormancy_record", move || {
        crate::livebrief::read_dormancy_record_events(&path, &agent_kind, &agent_session_id, &pty_session_id, false)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    const SID: &str = "11111111-1111-4111-8111-111111111111";
    const COMPLETE: &str = "{\"type\":\"user\",\"message\":{\"content\":\"Inspect the example\"}}\n{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"The example is complete\"}]}}\n";

    #[test]
    fn completed_conversation_is_saved_and_readable_without_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jsonl");
        fs::write(&source, COMPLETE).unwrap();
        let target = record_path(dir.path(), "claude", SID).unwrap();
        let receipt = save_record(&source, &target, "claude", SID, "pty", 7).unwrap();
        assert!(receipt.bytes > 0);
        assert_eq!(receipt.pty_generation, 7);
        fs::rename(&source, dir.path().join("moved-source.jsonl")).unwrap();
        let events = crate::livebrief::read_dormancy_record_events(&target, "claude", SID, "pty", false).unwrap();
        assert_eq!(events.telemetry_health, "ended");
        assert_eq!(events.events.len(), 2);
    }

    #[test]
    fn incomplete_or_empty_transcripts_never_produce_a_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jsonl");
        let target = record_path(dir.path(), "claude", SID).unwrap();
        for body in [String::new(), format!("{COMPLETE}{{\"type\":\"assistant\""), format!("{COMPLETE}{{\"type\":\"user\",\"message\":{{\"content\":\"Next task\"}}}}\n")] {
            fs::write(&source, body).unwrap();
            assert!(save_record(&source, &target, "claude", SID, "pty", 1).is_err());
            assert!(!target.exists());
        }
    }

    #[test]
    fn an_unwritable_record_destination_never_produces_a_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jsonl");
        fs::write(&source, COMPLETE).unwrap();
        let parent = dir.path().join("file-as-parent");
        fs::write(&parent, "occupied").unwrap();
        assert!(save_record(&source, &parent.join("record.jsonl"), "claude", SID, "pty", 1).is_err());
    }

    #[test]
    fn codex_completed_reply_is_readable_from_the_saved_record() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jsonl");
        fs::write(&source, concat!(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Inspect the example\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"The example is complete\"}]}}\n"
        )).unwrap();
        let target = record_path(dir.path(), "codex", SID).unwrap();
        let receipt = save_record(&source, &target, "codex", SID, "pty", 8).unwrap();
        assert_eq!(receipt.agent_kind, "codex");
        let events = crate::livebrief::read_dormancy_record_events(&target, "codex", SID, "pty", false).unwrap();
        assert_eq!(events.events.len(), 2);
    }

    #[test]
    fn a_pending_question_never_produces_a_completion_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jsonl");
        fs::write(&source, format!("{COMPLETE}{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"tool_use\",\"id\":\"question-1\",\"name\":\"AskUserQuestion\",\"input\":{{\"questions\":[{{\"question\":\"Proceed?\",\"options\":[{{\"label\":\"Yes\"}},{{\"label\":\"No\"}}]}}]}}}}]}}}}\n")).unwrap();
        let target = record_path(dir.path(), "claude", SID).unwrap();
        assert!(save_record(&source, &target, "claude", SID, "pty", 1).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn record_paths_reject_unsupported_agents_and_path_components() {
        assert!(record_path(Path::new("example"), "shell", SID).is_err());
        assert!(record_path(Path::new("example"), "claude", "../../other").is_err());
    }
}
