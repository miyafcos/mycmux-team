use std::path::Path;

use crate::agent_transcript::{
    copy_claude_transcript, import_codex_transcript, locate_claude_transcript_exact,
    locate_codex_transcript,
};
use crate::pty::path_norm::claude_project_key;

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DuplicateAgentSessionResult {
    pub agent_kind: String,
    pub source_session_id: String,
    pub new_session_id: String,
    pub resolved_cwd: String,
}

fn duplicate_agent_session_in_home(kind: &str, session_id: &str, resolved_cwd: &str, home: &Path) -> Result<DuplicateAgentSessionResult, String> {
    let new_session_id = match kind {
        "claude" | "claude-codex" => {
            let projects = if kind == "claude" {
                home.join(".claude").join("projects")
            } else {
                home.join(".claude-codex").join("config").join("projects")
            };
            let source = locate_claude_transcript_exact(&projects, resolved_cwd, session_id)?;
            let new_session_id = uuid::Uuid::new_v4().to_string();
            copy_claude_transcript(&source, &projects.join(claude_project_key(resolved_cwd)).join(format!("{new_session_id}.jsonl")))?;
            new_session_id
        }
        "codex" => {
            let sessions = home.join(".codex").join("sessions");
            let (source, _) = locate_codex_transcript(&sessions, resolved_cwd, Some(session_id))?;
            import_codex_transcript(&source, &sessions, session_id, resolved_cwd)?
        }
        _ => return Err(format!("Unsupported agent kind: {kind}")),
    };
    Ok(DuplicateAgentSessionResult {
        agent_kind: kind.to_string(),
        source_session_id: session_id.to_string(),
        new_session_id,
        resolved_cwd: resolved_cwd.to_string(),
    })
}

#[tauri::command(async)]
pub fn duplicate_agent_session(kind: String, session_id: String, cwd: Option<String>) -> Result<DuplicateAgentSessionResult, String> {
    let resolved_cwd = crate::commands::terminal::resolve_launch_cwd(cwd.as_deref())
        .ok_or_else(|| "Failed to resolve launch working directory".to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    duplicate_agent_session_in_home(&kind, &session_id, &resolved_cwd, &home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn claude_record() -> &'static str { r#"{"type":"user","message":{"content":"hello"}}"# }
    fn codex_meta(id: &str, cwd: &str) -> String {
        serde_json::json!({"type":"session_meta","payload":{"id":id,"session_id":id,"cwd":cwd}}).to_string()
    }
    fn claude_source(home: &Path, id: &str, contents: &str) -> std::path::PathBuf {
        let source = home.join(".claude/projects/other-key").join(format!("{id}.jsonl"));
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, contents).unwrap();
        source
    }

    #[test]
    fn claude_clone_finds_another_project_and_uses_destination_key() {
        let temp = tempfile::tempdir().unwrap(); let id = uuid::Uuid::new_v4().to_string(); let cwd = r"C:\work\destination";
        claude_source(temp.path(), &id, &format!("{}\n", claude_record()));
        let result = duplicate_agent_session_in_home("claude", &id, cwd, temp.path()).unwrap();
        assert!(temp.path().join(".claude/projects").join(claude_project_key(cwd)).join(format!("{}.jsonl", result.new_session_id)).is_file());
    }
    #[test]
    fn claude_clone_leaves_source_unchanged() {
        let temp = tempfile::tempdir().unwrap(); let id = uuid::Uuid::new_v4().to_string(); let cwd = r"C:\work\unchanged";
        let source = claude_source(temp.path(), &id, &format!("{}\n", claude_record())); let before = fs::read(&source).unwrap();
        duplicate_agent_session_in_home("claude", &id, cwd, temp.path()).unwrap(); assert_eq!(fs::read(source).unwrap(), before);
    }
    #[test]
    fn clone_drops_incomplete_final_record() {
        let temp = tempfile::tempdir().unwrap(); let id = uuid::Uuid::new_v4().to_string(); let cwd = r"C:\work\complete";
        claude_source(temp.path(), &id, &format!("{}\n{{\"partial\":", claude_record()));
        let result = duplicate_agent_session_in_home("claude", &id, cwd, temp.path()).unwrap();
        assert_eq!(fs::read_to_string(temp.path().join(".claude/projects").join(claude_project_key(cwd)).join(format!("{}.jsonl", result.new_session_id))).unwrap(), format!("{}\n", claude_record()));
    }
    // A file that simply ends without its newline is complete, not torn. Savepoint
    // bundles are written that way at rest, so dropping the record here would lose
    // the last conversation turn of every cloned session.
    #[test]
    fn clone_keeps_a_valid_final_record_that_lacks_its_newline() {
        let temp = tempfile::tempdir().unwrap(); let id = uuid::Uuid::new_v4().to_string(); let cwd = r"C:\work\unterminated";
        claude_source(temp.path(), &id, &format!("{}\n{}", claude_record(), claude_record()));
        let result = duplicate_agent_session_in_home("claude", &id, cwd, temp.path()).unwrap();
        assert_eq!(fs::read_to_string(temp.path().join(".claude/projects").join(claude_project_key(cwd)).join(format!("{}.jsonl", result.new_session_id))).unwrap(), format!("{}\n{}\n", claude_record(), claude_record()));
    }
    #[test]
    fn codex_clone_rewrites_payload_id_session_and_cwd() {
        let temp = tempfile::tempdir().unwrap(); let id = uuid::Uuid::new_v4().to_string(); let cwd = r"C:\work\codex";
        let source = temp.path().join(".codex/sessions/2026/01/01").join(format!("rollout-2026-01-01T00-00-00-{id}.jsonl")); fs::create_dir_all(source.parent().unwrap()).unwrap(); fs::write(&source, format!("{}\n{{\"type\":\"response_item\"}}\n", codex_meta(&id, "old"))).unwrap();
        let result = duplicate_agent_session_in_home("codex", &id, cwd, temp.path()).unwrap();
        let expected = temp.path().join(".codex/sessions"); let mut found = None; let mut dirs = vec![expected]; while let Some(dir) = dirs.pop() { for entry in fs::read_dir(dir).unwrap().flatten() { let path = entry.path(); if path.is_dir() { dirs.push(path) } else if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(&format!("-{}.jsonl", result.new_session_id))) { found = Some(path) } } }
        let value: serde_json::Value = serde_json::from_str(fs::read_to_string(found.unwrap()).unwrap().lines().next().unwrap()).unwrap(); assert_eq!(value["payload"]["id"], result.new_session_id); assert_eq!(value["payload"]["session_id"], result.new_session_id); assert_eq!(value["payload"]["cwd"], cwd);
    }
    #[test]
    fn clone_is_written_at_the_restore_lookup_path() {
        let temp = tempfile::tempdir().unwrap(); let id = uuid::Uuid::new_v4().to_string(); let cwd = r"C:\work\restore";
        claude_source(temp.path(), &id, &format!("{}\n", claude_record())); let result = duplicate_agent_session_in_home("claude", &id, cwd, temp.path()).unwrap();
        assert!(temp.path().join(".claude/projects").join(claude_project_key(cwd)).join(format!("{}.jsonl", result.new_session_id)).is_file());
    }
    #[test]
    fn missing_source_fails_without_latest_fallback() {
        let temp = tempfile::tempdir().unwrap(); let id = uuid::Uuid::new_v4().to_string(); let cwd = r"C:\work\missing";
        claude_source(temp.path(), &uuid::Uuid::new_v4().to_string(), &format!("{}\n", claude_record()));
        assert!(duplicate_agent_session_in_home("claude", &id, cwd, temp.path()).is_err());
    }
}
