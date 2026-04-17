use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use super::codex::run_codex_exec;
use super::BUDDY_ENABLED;

fn buddy_runtime_dir() -> Result<PathBuf, String> {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        return Ok(PathBuf::from(user_profile).join(".claude-buddy"));
    }
    if let Ok(home) = std::env::var("HOME") {
        return Ok(PathBuf::from(home).join(".claude-buddy"));
    }
    Err("USERPROFILE/HOME is not available".to_string())
}

fn ensure_runtime_dir(path: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("failed to create runtime directory {}: {error}", parent.display())
        })?;
    }
    Ok(())
}

fn append_jsonl(filename: &str, line: &str) -> Result<(), String> {
    let path = buddy_runtime_dir()?.join(filename);
    ensure_runtime_dir(&path)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub async fn codex_judge(system_prompt: String, user_prompt: String) -> Result<String, String> {
    eprintln!(
        "[buddy][codex_judge] called (prompt len: system={} user={})",
        system_prompt.len(),
        user_prompt.len()
    );
    let stdin_payload = format!("{system_prompt}\n\n---\n\n{user_prompt}");
    run_codex_exec(stdin_payload, "codex_judge").await
}

#[tauri::command]
pub async fn codex_summarize(prompt: String) -> Result<String, String> {
    eprintln!(
        "[buddy][codex_summarize] called (prompt len={})",
        prompt.len()
    );
    run_codex_exec(prompt, "codex_summarize").await
}

#[tauri::command]
pub fn load_buddy_environment() -> Result<String, String> {
    Ok(super::environment::build_environment_text())
}

#[tauri::command]
pub fn load_session_tail(
    session_id: String,
    cwd: String,
    max_turns: usize,
) -> Result<String, String> {
    Ok(super::session_log::load_session_tail(&session_id, &cwd, max_turns))
}

#[tauri::command]
pub fn load_buddy_settings() -> Result<String, String> {
    let path = buddy_runtime_dir()?.join("settings.json");
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path)
        .map_err(|error| format!("failed to read settings {}: {error}", path.display()))
}

#[tauri::command]
pub fn append_buddy_log(line: String) -> Result<(), String> {
    append_jsonl("log.jsonl", &line)
}

#[tauri::command]
pub fn append_buddy_chat(line: String) -> Result<(), String> {
    append_jsonl("chat.jsonl", &line)
}

#[tauri::command]
pub fn load_recent_chat(limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let path = buddy_runtime_dir()?.join("chat.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read chat log {}: {error}", path.display()))?;
    let mut entries: Vec<serde_json::Value> = content
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(limit)
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .collect();
    entries.reverse();
    Ok(entries)
}

#[tauri::command]
pub fn load_chat_since(timestamp_ms: i64) -> Result<Vec<serde_json::Value>, String> {
    let path = buddy_runtime_dir()?.join("chat.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read chat log {}: {error}", path.display()))?;
    let entries: Vec<serde_json::Value> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|value| {
            value
                .get("timestampMs")
                .and_then(|ts| ts.as_i64())
                .map(|ts| ts >= timestamp_ms)
                .unwrap_or(false)
        })
        .collect();
    Ok(entries)
}

#[tauri::command]
pub fn load_buddy_profile() -> Result<String, String> {
    let path = buddy_runtime_dir()?.join("profile.md");
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path)
        .map_err(|error| format!("failed to read profile {}: {error}", path.display()))
}

#[tauri::command]
pub fn save_buddy_profile(content: String) -> Result<(), String> {
    let path = buddy_runtime_dir()?.join("profile.md");
    ensure_runtime_dir(&path)?;
    fs::write(&path, content)
        .map_err(|error| format!("failed to write profile {}: {error}", path.display()))
}

#[tauri::command]
pub fn set_buddy_enabled(enabled: bool) -> bool {
    BUDDY_ENABLED.store(enabled, Ordering::Relaxed);
    enabled
}

#[tauri::command]
pub fn is_buddy_enabled() -> bool {
    BUDDY_ENABLED.load(Ordering::Relaxed)
}
