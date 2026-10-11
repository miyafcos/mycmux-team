//! Async IPC boundary; authorization uses the existing exact mapping only.
use tauri::{Manager, Window};
use super::archive::{self, Descriptor, Page, PageRequest, BodyPage};
use crate::commands::session_mapping::agent_mappings_for_ids;

fn authorize(owner: &str, request: &Descriptor) -> Result<(), String> {
    let mappings = agent_mappings_for_ids([&request.pty_session_id, &request.tab_id]);
    let mapping = mappings.get(&request.pty_session_id).or_else(|| mappings.get(&request.tab_id));
    match mapping {
        Some(mapping) if mapping.agent_kind.as_deref() == Some(request.expected_agent_kind.as_str()) && mapping.session_id == request.expected_agent_session_id => Ok(()),
        Some(_) => Err("identityMismatch".into()),
        None if archive::accepted(owner, request) => Ok(()),
        None => Err("unlinked".into()),
    }
}
fn root(kind: &str) -> Result<std::path::PathBuf, String> {
    let root = if crate::test_profile::is_active() { crate::test_profile::agent_projects_dir(kind) } else {
        match kind { "claude" => crate::ailog::claude_root(), "claude-codex" => crate::ailog::claude_codex_root(), "codex" => crate::ailog::codex_root(), _ => None }
    };
    root.ok_or("recordMissing".into())
}
#[tauri::command(async)]
pub async fn open_transcript_history(window: Window, request: Descriptor) -> Result<Page, String> {
    let owner = window.label().to_string();
    let app = window.app_handle().clone();
    crate::util::task::run_blocking("open_transcript_history", move || {
        if app.get_window(&owner).is_none() { return Err("cursorExpired".into()); }
        authorize(&owner, &request)?;
        let result = archive::open(&owner, request.clone(), root(&request.expected_agent_kind)?)?;
        if app.get_window(&owner).is_none() { archive::close(&owner, &result.reader_id); return Err("cursorExpired".into()); }
        if let Err(error) = authorize(&owner, &request) { archive::close(&owner, &result.reader_id); return Err(error); }
        Ok(result)
    }).await
}
#[tauri::command(async)]
pub async fn read_transcript_history_page(window: Window, request: PageRequest) -> Result<Page, String> {
    let owner = window.label().to_string();
    crate::util::task::run_blocking("read_transcript_history_page", move || archive::page(&owner, request)).await
}
#[tauri::command(async)]
pub async fn refresh_transcript_history_tail(window: Window, reader_id: String, after_cursor: String) -> Result<Page, String> {
    let owner = window.label().to_string();
    crate::util::task::run_blocking("refresh_transcript_history_tail", move || {
        let descriptor = archive::descriptor(&owner,&reader_id)?;
        authorize(&owner,&descriptor).map_err(|_| "bindingChanged".to_string())?;
        archive::refresh(&owner, &reader_id, &after_cursor)
    }).await
}
#[tauri::command(async)]
pub async fn read_transcript_history_body(window: Window, reader_id: String, body_ref: String, cursor: Option<String>) -> Result<BodyPage, String> {
    let owner = window.label().to_string();
    crate::util::task::run_blocking("read_transcript_history_body", move || archive::body(&owner, &reader_id, &body_ref, cursor.as_deref())).await
}
#[tauri::command(async)]
pub async fn close_transcript_history(window: Window, reader_id: String) -> Result<(), String> {
    let owner = window.label().to_string();
    crate::util::task::run_blocking("close_transcript_history", move || { archive::close(&owner, &reader_id); Ok(()) }).await
}
#[tauri::command(async)]
pub async fn heartbeat_transcript_history(window:Window,reader_id:String)->Result<archive::Heartbeat,String> {
    let owner=window.label().to_string();
    crate::util::task::run_blocking("heartbeat_transcript_history",move||{
        authorize(&owner,&archive::descriptor(&owner,&reader_id)?).map_err(|_|"bindingChanged".to_string())?;
        archive::heartbeat(&owner,&reader_id)
    }).await
}
