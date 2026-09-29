use super::{chunk, message_text, records, valid_session, Evidence, TitleRequest};
use std::path::{Path, PathBuf};
fn find(root: &Path, suffix: &str, depth: usize) -> Option<PathBuf> {
    let mut entries: Vec<_> = std::fs::read_dir(root).ok()?.flatten().collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    for entry in entries {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("rollout-") && name.ends_with(suffix) {
                return Some(entry.path());
            }
        } else if kind.is_dir() && depth < 3 {
            if let Some(path) = find(&entry.path(), suffix, depth + 1) {
                return Some(path);
            }
        }
    }
    None
}
pub(super) fn locate(request: &TitleRequest) -> Option<PathBuf> {
    let session = request.agent_session_id.as_deref()?;
    if !valid_session(session) {
        return None;
    }
    find(
        &crate::ailog::codex_root()?,
        &format!("-{session}.jsonl"),
        0,
    )
}
pub(super) fn read(path: &Path) -> Evidence {
    let head = chunk(path, 4 * 1024 * 1024, false).unwrap_or_default();
    let prompt = records(&head)
        .filter(|r| r["type"] == "response_item" && r["payload"]["role"] == "user")
        .filter_map(|r| message_text(&r["payload"]))
        .find(|s| !s.starts_with("# AGENTS.md") && !s.starts_with('<'));
    Evidence {
        title: None,
        prompt,
    }
}
