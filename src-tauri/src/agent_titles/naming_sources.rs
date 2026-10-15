//! CWD/time scans are diagnostic only unless a current, trusted conversation ID proves ownership.
use super::{chunk, codex, valid_session, TitleRequest};
use crate::pty::path_norm::normalize_cwd_key;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Clone)]
pub(super) struct CodexLookup {
    pub session_id: Option<String>,
    pub started_at: u64,
    pub excluded_ids: Vec<String>,
    pub contended: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LookupFailure { Unverified, Incomplete, Contended, Budget }
impl LookupFailure {
    pub(super) fn status(self) -> &'static str {
        match self {
            Self::Unverified => "unverified",
            Self::Contended => "contended",
            Self::Incomplete | Self::Budget => "incomplete",
        }
    }
}

fn visit(root: &Path, depth: usize, remaining: &mut usize, deadline: Instant, files: &mut Vec<PathBuf>) -> Result<(), LookupFailure> {
    if *remaining == 0 || Instant::now() >= deadline { return Err(LookupFailure::Budget); }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if depth == 0 && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(LookupFailure::Incomplete),
    };
    for entry in entries {
        if *remaining == 0 || Instant::now() >= deadline { return Err(LookupFailure::Budget); }
        *remaining -= 1;
        let entry = entry.map_err(|_| LookupFailure::Incomplete)?;
        let kind = entry.file_type().map_err(|_| LookupFailure::Incomplete)?;
        if kind.is_symlink() { continue; }
        if kind.is_dir() {
            if depth >= 3 { return Err(LookupFailure::Budget); }
            visit(&entry.path(), depth + 1, remaining, deadline, files)?;
        } else if kind.is_file() && entry.file_name().to_string_lossy().starts_with("rollout-")
            && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            files.push(entry.path());
        }
    }
    Ok(())
}
fn matching_header(path: &Path, cwd: &str, started_at: u64) -> Result<Option<String>, LookupFailure> {
    let bytes = chunk(path, 32 * 1024, false).ok_or(LookupFailure::Incomplete)?;
    let line = bytes.split(|b| *b == b'\n').next().ok_or(LookupFailure::Incomplete)?;
    let value: serde_json::Value = serde_json::from_slice(line).map_err(|_| LookupFailure::Incomplete)?;
    if value["type"] != "session_meta" { return Err(LookupFailure::Incomplete); }
    let payload = &value["payload"];
    let source = &payload["source"];
    if matches!(source.as_str(), Some("subagent" | "exec"))
        || source.as_object().is_some_and(|source| source.contains_key("subagent"))
        || !payload["parent_thread_id"].is_null() || payload["thread_source"] == "subagent"
        || payload["originator"] == "codex_exec" { return Ok(None); }
    let recorded_cwd = payload["cwd"].as_str().ok_or(LookupFailure::Incomplete)?;
    if normalize_cwd_key(recorded_cwd) != normalize_cwd_key(cwd) { return Ok(None); }
    let id = payload["id"].as_str().filter(|id| valid_session(id)).ok_or(LookupFailure::Incomplete)?;
    let stamp = payload["timestamp"].as_str().or_else(|| value["timestamp"].as_str()).ok_or(LookupFailure::Incomplete)?;
    let stamp = u64::try_from(chrono::DateTime::parse_from_rfc3339(stamp)
        .map_err(|_| LookupFailure::Incomplete)?.timestamp_millis()).map_err(|_| LookupFailure::Incomplete)?;
    Ok((stamp.abs_diff(started_at) <= 30_000).then(|| id.to_owned()))
}
fn scan_in(root: &Path, request: &TitleRequest, lookup: &CodexLookup, deadline: Instant,
    remaining: &mut usize, found: &mut Option<(PathBuf, String)>) -> Result<(), LookupFailure> {
    let mut files = Vec::new();
    visit(root, 0, remaining, deadline, &mut files)?;
    if *remaining == 0 || Instant::now() >= deadline { return Err(LookupFailure::Budget); }
    for path in files {
        if Instant::now() >= deadline { return Err(LookupFailure::Budget); }
        if let Some(id) = matching_header(&path, &request.cwd, lookup.started_at)? {
            if lookup.excluded_ids.contains(&id) { continue; }
            if found.is_some() { return Err(LookupFailure::Contended); }
            *found = Some((path, id));
        }
    }
    Ok(())
}
fn owned(found: Option<(PathBuf, String)>, lookup: &CodexLookup) -> Result<Option<(PathBuf, String)>, LookupFailure> {
    if found.as_ref().is_some_and(|(_, id)| lookup.session_id.as_deref() != Some(id)) {
        return Err(LookupFailure::Unverified);
    }
    Ok(found)
}
#[cfg(test)]
pub(super) fn locate_in(root: &Path, request: &TitleRequest, lookup: &CodexLookup, deadline: Instant) -> Result<Option<(PathBuf, String)>, LookupFailure> {
    if lookup.contended { return Err(LookupFailure::Contended); }
    let mut found = None;
    scan_in(root, request, lookup, deadline, &mut 2048, &mut found)?;
    owned(found, lookup)
}
pub(super) fn locate(request: &TitleRequest, lookup: &CodexLookup, deadline: Instant) -> Result<Option<(PathBuf, String)>, LookupFailure> {
    if let Some(id) = lookup.session_id.as_deref().filter(|id| valid_session(id)) {
        let mut exact = request.clone(); exact.agent_session_id = Some(id.to_owned());
        return Ok(codex::locate(&exact).map(|path| (path, id.to_owned())));
    }
    if lookup.contended { return Err(LookupFailure::Contended); }
    let root = crate::ailog::codex_root().ok_or(LookupFailure::Incomplete)?;
    let stamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(i64::try_from(lookup.started_at)
        .map_err(|_| LookupFailure::Incomplete)?).ok_or(LookupFailure::Incomplete)?;
    let mut found = None; let mut remaining = 2048;
    for delta in -1..=1 {
        let day = stamp.date_naive() + chrono::Duration::days(delta);
        scan_in(&root.join(day.format("%Y/%m/%d").to_string()), request, lookup, deadline, &mut remaining, &mut found)?;
    }
    // This path never upgrades a CWD/time candidate to an owned conversation.
    owned(found, lookup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn request() -> TitleRequest {
        TitleRequest {
            tab_id: "t".into(),
            agent_kind: "codex".into(),
            agent_session_id: None,
            cwd: "C:/work".into(),
        }
    }
    fn put(root: &Path, name: &str, cwd: &str, source: serde_json::Value) {
        let value = serde_json::json!({ "type":"session_meta", "timestamp":"2026-10-14T08:00:00Z",
            "payload":{"id":name,"cwd":cwd,"source":source} });
        std::fs::write(
            root.join(format!("rollout-{name}.jsonl")),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    fn lookup() -> CodexLookup {
        CodexLookup {
            session_id: None,
            excluded_ids: Vec::new(),
            contended: false,
            started_at: 1791964800000,
        }
    }
    #[test]
    fn resolves_a_unique_matching_header_only_with_confirmed_ownership() {
        let root = tempfile::tempdir().unwrap();
        put(root.path(), "right", "C:/work", serde_json::json!("cli"));
        put(
            root.path(),
            "other-cwd",
            "C:/other",
            serde_json::json!("cli"),
        );
        let end = Instant::now() + Duration::from_secs(5);
        assert_eq!(
            locate_in(root.path(), &request(), &CodexLookup { session_id:Some("right".into()), ..lookup() }, end)
                .unwrap()
                .unwrap()
                .1,
            "right"
        );
        put(
            root.path(),
            "ambiguous",
            "C:/work",
            serde_json::json!("cli"),
        );
        assert!(locate_in(root.path(), &request(), &lookup(), end).is_err());
    }
    #[test]
    fn rejects_a_record_owned_by_another_pane_or_a_contended_process_birth() {
        let root = tempfile::tempdir().unwrap();
        put(root.path(), "claimed", "C:/work", serde_json::json!("cli"));
        let end = Instant::now() + Duration::from_secs(5);
        let excluded = CodexLookup {
            excluded_ids: vec!["claimed".into()],
            ..lookup()
        };
        assert!(locate_in(root.path(), &request(), &excluded, end)
            .unwrap()
            .is_none());
        let contended = CodexLookup {
            contended: true,
            ..lookup()
        };
        assert!(locate_in(root.path(), &request(), &contended, end).is_err());
    }
    #[test]
    fn ignores_child_exec_old_and_unobserved_rollouts() {
        let root = tempfile::tempdir().unwrap();
        put(
            root.path(),
            "child",
            "C:/work",
            serde_json::json!({"subagent":"review"}),
        );
        put(root.path(), "exec", "C:/work", serde_json::json!("exec"));
        let end = Instant::now() + Duration::from_secs(5);
        assert!(locate_in(root.path(), &request(), &lookup(), end)
            .unwrap()
            .is_none());
        put(root.path(), "old", "C:/work", serde_json::json!("cli"));
        let old = CodexLookup {
            started_at: lookup().started_at + 60_000,
            ..lookup()
        };
        assert!(locate_in(root.path(), &request(), &old, end)
            .unwrap()
            .is_none());
        assert!(locate_in(root.path(), &request(), &lookup(), Instant::now()).is_err());
    }
}

#[cfg(test)]
#[path = "naming_fix2_tests.rs"]
mod fix2_tests;
