use chrono::Utc;
use crsm_core::path_norm::claude_project_key;
use crsm_core::worksets::{load_workset, save_workset};
use crsm_core::{
    create_handoff_file, list_all_sessions, AgentKind, HandoffRequest, ListOptions, OpenMode,
    Workset, WorksetEntry, WorksetLayout,
};
use std::fs;
use std::path::{Path, PathBuf};

fn unique_home() -> PathBuf {
    std::env::temp_dir().join(format!(
        "crsm-smoke-{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ))
}

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

#[test]
fn scans_handoff_and_round_trips_worksets() {
    let home = unique_home();
    std::env::set_var("CRSM_HOME", &home);

    let cwd = home.join("repo").to_string_lossy().to_string();
    let claude_id = "claude-smoke-session";
    let hybrid_id = "hybrid-smoke-session";
    let codex_id = "codex-smoke-session";

    let archive = home.join(".claude").join("session-archive");
    write_file(
        &archive.join("index.jsonl"),
        &format!(
            "{}\n",
            serde_json::json!({
                "timestamp": "2026-05-02T00:00:00Z",
                "session_id": claude_id,
                "cwd": cwd,
                "first_message": "Start smoke handoff",
                "assistant_conclusion": "Finished smoke handoff",
                "summary_file": "summaries/claude-smoke-session.md",
                "files_modified": ["src/lib.rs"],
                "incomplete_tasks": ["finish smoke test"]
            })
        ),
    );
    write_file(
        &archive.join("summaries").join("claude-smoke-session.md"),
        "---\nincomplete_tasks:\n  - finish smoke test\n---\nSummary body\n",
    );
    write_file(
        &home
            .join(".claude")
            .join("projects")
            .join(claude_project_key(&cwd))
            .join(format!("{claude_id}.jsonl")),
        &format!(
            "{}\n{}\n",
            serde_json::json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        { "type": "tool_result", "content": "MEMORY.md full text" },
                        { "type": "text", "text": "Real user request\nwith structure" }
                    ]
                }
            }),
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Assistant reply\nsecond line" }]
                }
            })
        ),
    );
    write_file(
        &home
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("05")
            .join("02")
            .join("rollout-smoke.jsonl"),
        &format!(
            "{}\n{}\n",
            serde_json::json!({
                "timestamp": "2026-05-02T00:00:00Z",
                "type": "session_meta",
                "payload": { "id": codex_id, "cwd": cwd }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "Codex smoke request" }]
                }
            })
        ),
    );
    write_file(
        &home
            .join(".claude-codex")
            .join("config")
            .join("projects")
            .join(claude_project_key(&cwd))
            .join(format!("{hybrid_id}.jsonl")),
        &format!(
            "{}\n{}\n{}\n",
            serde_json::json!({
                "type": "last-prompt",
                "sessionId": hybrid_id
            }),
            serde_json::json!({
                "type": "user",
                "cwd": cwd,
                "sessionId": hybrid_id,
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "Hybrid smoke request" }]
                }
            }),
            serde_json::json!({
                "type": "assistant",
                "cwd": cwd,
                "sessionId": hybrid_id,
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Hybrid smoke reply" }]
                }
            })
        ),
    );

    let sessions = list_all_sessions(&ListOptions {
        refresh: true,
        use_cache: false,
    })
    .unwrap();
    assert!(sessions
        .iter()
        .any(|entry| entry.kind == AgentKind::Claude && entry.id == claude_id));
    assert!(sessions
        .iter()
        .any(|entry| entry.kind == AgentKind::Codex && entry.id == codex_id));
    assert!(sessions
        .iter()
        .any(|entry| entry.kind == AgentKind::ClaudeCodex && entry.id == hybrid_id));

    let cached_sessions = list_all_sessions(&ListOptions {
        refresh: true,
        use_cache: true,
    })
    .unwrap();
    assert!(cached_sessions
        .iter()
        .any(|entry| entry.kind == AgentKind::Codex && entry.id == codex_id));

    let codex_id_2 = "codex-smoke-session-later";
    write_file(
        &home
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("05")
            .join("03")
            .join("rollout-smoke-later.jsonl"),
        &format!(
            "{}\n{}\n",
            serde_json::json!({
                "timestamp": "2026-05-03T00:00:00Z",
                "type": "session_meta",
                "payload": { "id": codex_id_2, "cwd": cwd.clone() }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "Later Codex request" }]
                }
            })
        ),
    );
    let refreshed_sessions = list_all_sessions(&ListOptions {
        refresh: true,
        use_cache: true,
    })
    .unwrap();
    assert!(refreshed_sessions
        .iter()
        .any(|entry| entry.kind == AgentKind::Codex && entry.id == codex_id_2));

    let handoff = create_handoff_file(&HandoffRequest {
        session_id: claude_id.to_string(),
        from_kind: Some(AgentKind::Claude),
        target_kind: AgentKind::Codex,
        recent_turns: 20,
    })
    .unwrap();
    let handoff_text = fs::read_to_string(handoff.path).unwrap();
    assert!(handoff_text.contains("Real user request\nwith structure"));
    assert!(handoff_text.contains("Assistant reply\nsecond line"));
    assert!(!handoff_text.contains("MEMORY.md full text"));

    let workset = Workset {
        schema_version: 1,
        name: "roundtrip".to_string(),
        saved_at: Utc::now(),
        entries: vec![WorksetEntry {
            original_agent_kind: AgentKind::Claude,
            target_agent_kind: AgentKind::Claude,
            open_mode: OpenMode::Resume,
            session_id: claude_id.to_string(),
            cwd,
            label: "smoke".to_string(),
            last_mtime: Utc::now(),
            pane_hint: None,
        }],
        layout: WorksetLayout {
            kind: "grid".to_string(),
            cols: Some(1),
        },
        notes: None,
    };
    save_workset(&workset).unwrap();
    let loaded = load_workset("roundtrip").unwrap();
    assert_eq!(loaded.entries.len(), 1);
    assert_eq!(loaded.entries[0].session_id, claude_id);
}
