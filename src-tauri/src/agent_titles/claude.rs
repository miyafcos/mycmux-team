use super::{chunk, message_text, records, valid_session, Evidence, TitleRequest};
use std::path::{Path, PathBuf};
fn locate_at(root: Option<PathBuf>, request: &TitleRequest) -> Option<PathBuf> {
    let session = request.agent_session_id.as_deref()?;
    if !valid_session(session) {
        return None;
    }
    crate::agent_transcript::locate_claude_transcript_exact(&root?, &request.cwd, session).ok()
}
pub(super) fn locate(request: &TitleRequest) -> Option<PathBuf> {
    locate_at(crate::ailog::claude_root(), request)
}
pub(super) fn locate_codex_wrapper(request: &TitleRequest) -> Option<PathBuf> {
    locate_at(crate::ailog::claude_codex_root(), request)
}
fn title(bytes: &[u8]) -> Option<String> {
    let mut custom = None;
    let mut ai = None;
    for record in records(bytes) {
        let (slot, field) = match record.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "custom-title" => (&mut custom, "customTitle"),
            "ai-title" => (&mut ai, "aiTitle"),
            _ => continue,
        };
        if let Some(text) = record
            .get(field)
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            *slot = Some(text.chars().take(4096).collect());
        }
    }
    custom.or(ai)
}
pub(super) fn read(path: &Path) -> Evidence {
    let session_title = title(&chunk(path, 2 * 1024 * 1024, true).unwrap_or_default())
        .or_else(|| title(&chunk(path, 256 * 1024, false).unwrap_or_default()));
    let head = chunk(path, 512 * 1024, false).unwrap_or_default();
    let prompt = records(&head)
        .filter(|r| r["type"] == "user")
        .filter_map(|r| message_text(&r["message"]))
        .find(|s| !s.starts_with('<'));
    Evidence {
        title: session_title,
        prompt,
    }
}
