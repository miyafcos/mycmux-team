use crate::models::{AgentKind, SessionEntry};
use crate::path_norm::{crsm_dir, home_dir};
use crate::preview::{extract_claude_handoff_text, extract_codex_visible_text, trim_transcript};
use crate::sessions::{find_session, summary_text_for_session, SessionError};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HandoffRequest {
    pub session_id: String,
    pub from_kind: Option<AgentKind>,
    pub target_kind: AgentKind,
    pub recent_turns: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HandoffResult {
    pub path: PathBuf,
    pub bootstrap_prompt: String,
    pub from_kind: AgentKind,
    pub target_kind: AgentKind,
    pub from_session_id: String,
    pub cwd: String,
}

#[derive(Clone, Debug)]
struct Turn {
    role: String,
    text: String,
}

pub fn create_handoff_file(request: &HandoffRequest) -> Result<HandoffResult, SessionError> {
    let home = home_dir().ok_or(SessionError::NoHome)?;
    let Some(entry) = find_session(&request.session_id, request.from_kind.clone())? else {
        return Err(SessionError::Io(format!(
            "session not found: {}",
            request.session_id
        )));
    };
    let turns = extract_turns(&entry, request.recent_turns);
    let summary = summary_text_for_session(&home, &entry);
    let markdown =
        render_handoff_markdown(&entry, &request.target_kind, &turns, summary.as_deref());
    let dir = crsm_dir(&home).join("handoff");
    fs::create_dir_all(&dir)
        .map_err(|error| SessionError::Io(format!("create handoff dir: {error}")))?;
    let timestamp = Utc::now().format("%Y%m%dT%H%M%SZ");
    let path = dir.join(format!(
        "{}-{}-to-{}.md",
        timestamp,
        entry.kind.as_str(),
        request.target_kind.as_str()
    ));
    fs::write(&path, markdown)
        .map_err(|error| SessionError::Io(format!("write handoff: {error}")))?;
    let bootstrap_prompt = format!(
        "Handoff from previous session. Read \"{}\" and continue from where it left off.",
        path.to_string_lossy()
    );
    Ok(HandoffResult {
        path,
        bootstrap_prompt,
        from_kind: entry.kind,
        target_kind: request.target_kind.clone(),
        from_session_id: entry.id,
        cwd: entry.cwd,
    })
}

fn extract_turns(entry: &SessionEntry, recent_turns: usize) -> Vec<Turn> {
    let Some(path) = entry.transcript_path.as_ref() else {
        return Vec::new();
    };
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut turns = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let turn = match entry.kind {
            AgentKind::Claude | AgentKind::ClaudeCodex => {
                extract_claude_handoff_text(&value).map(|(role, text)| Turn { role, text })
            }
            AgentKind::Codex => extract_codex_turn(&value),
        };
        if let Some(turn) = turn {
            turns.push(turn);
        }
    }
    let keep = recent_turns.max(1);
    if turns.len() > keep {
        turns.split_off(turns.len() - keep)
    } else {
        turns
    }
}

fn extract_codex_turn(value: &Value) -> Option<Turn> {
    let payload = value.get("payload").unwrap_or(value);
    let role = payload
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("event")
        .to_string();
    extract_codex_visible_text(value).map(|text| Turn { role, text })
}

fn render_handoff_markdown(
    entry: &SessionEntry,
    target_kind: &AgentKind,
    turns: &[Turn],
    summary: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "# Handoff from {} session {}\n\n",
        entry.kind.as_str(),
        entry.id
    ));
    out.push_str(&format!("- Target agent: {}\n", target_kind.as_str()));
    out.push_str(&format!("- Original cwd: {}\n", entry.cwd));
    out.push_str(&format!("- Last activity: {}\n", entry.last_activity));
    out.push('\n');

    if let Some(summary) = summary {
        out.push_str("## Original session summary\n\n");
        out.push_str(&trim_transcript(summary, Some(4000)));
        out.push_str("\n\n");
    }

    if !entry.files_modified.is_empty() {
        out.push_str("## Files referenced\n\n");
        for path in &entry.files_modified {
            out.push_str(&format!("- {}\n", path));
        }
        out.push('\n');
    }

    if !entry.incomplete_tasks.is_empty() {
        out.push_str("## Incomplete tasks\n\n");
        for task in &entry.incomplete_tasks {
            out.push_str(&format!("- {}\n", task));
        }
        out.push('\n');
    }

    out.push_str("## Recent context\n\n");
    if turns.is_empty() {
        out.push_str("(No transcript turns were extracted.)\n");
    }
    for (index, turn) in turns.iter().enumerate() {
        out.push_str(&format!("### [turn {}] {}\n\n", index + 1, turn.role));
        out.push_str(&turn.text);
        out.push_str("\n\n");
    }
    out
}
