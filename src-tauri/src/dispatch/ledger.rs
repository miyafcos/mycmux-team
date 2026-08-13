use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use super::DispatchEntry;

const STALL_MINUTES: f64 = 5.0;

pub fn slugify_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|character| if character.is_ascii_alphanumeric() { character } else { '-' })
        .collect()
}

pub fn ledger_path() -> Option<PathBuf> {
    std::env::var_os("DISPATCH_LEDGER")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude").join("dispatch").join("ledger.jsonl")))
}

fn projects_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

fn optional_string(record: &Map<String, Value>, key: &str) -> Option<String> {
    record.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

fn mtime_ms(path: &Path) -> Option<u64> {
    path.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|value| value.as_millis() as u64)
}

fn has_file(dir: Option<&str>, name: &str) -> (bool, Option<u64>) {
    let Some(dir) = dir else { return (false, None); };
    let path = Path::new(dir).join(name);
    (path.is_file(), mtime_ms(&path))
}

pub fn load_entries(path: &Path) -> io::Result<BTreeMap<String, Map<String, Value>>> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let bytes = fs::read(path)?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let mut entries: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    for raw_line in bytes.split(|byte| *byte == b'\n') {
        let Ok(line) = std::str::from_utf8(raw_line) else { continue; };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(trimmed) else { continue; };
        let Some(slug) = optional_string(&record, "slug").filter(|value| !value.is_empty()) else { continue; };
        entries.entry(slug).and_modify(|current| current.extend(record.clone())).or_insert(record);
    }
    Ok(entries)
}

pub fn session_activity(projects: &Path, cwd: Option<&str>, now: SystemTime) -> (Option<String>, f64) {
    let Some(cwd) = cwd.filter(|value| !value.is_empty()) else { return (None, -1.0); };
    let project_dir = projects.join(slugify_cwd(cwd));
    let Ok(read_dir) = fs::read_dir(project_dir) else { return (None, -1.0); };
    let mut newest: Option<(String, SystemTime)> = None;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else { continue; };
        if newest.as_ref().is_none_or(|(_, current)| modified > *current) {
            newest = Some((entry.file_name().to_string_lossy().into_owned(), modified));
        }
    }
    let Some((name, modified)) = newest else { return (None, -1.0); };
    let age = now.duration_since(modified).unwrap_or_default().as_secs_f64() / 60.0;
    (Some(name), age)
}

fn live_state(status: Option<&str>, has_done: bool, has_ask: bool, rate_limited: bool, log_age: f64) -> String {
    if status == Some("closed") {
        "CLOSED".to_owned()
    } else if has_done {
        if status == Some("open") { "DONE_NEEDS_REVIEW".to_owned() } else { "DONE".to_owned() }
    } else if has_ask {
        "ASK".to_owned()
    } else if rate_limited {
        "RATE_LIMITED".to_owned()
    } else if log_age < 0.0 {
        "NO_LOG".to_owned()
    } else if log_age <= STALL_MINUTES {
        "RUNNING".to_owned()
    } else {
        "STALL".to_owned()
    }
}

fn entry_from_record(record: Map<String, Value>, projects: &Path, rate_limited_sessions: &HashSet<String>, now: SystemTime) -> DispatchEntry {
    let slug = optional_string(&record, "slug").unwrap_or_default();
    let dir = optional_string(&record, "dir");
    let cwd = optional_string(&record, "cwd");
    let status = optional_string(&record, "status");
    let (has_done, done_mtime_ms) = has_file(dir.as_deref(), "DONE.md");
    let (has_ask, ask_mtime_ms) = has_file(dir.as_deref(), "ASK.md");
    let (has_verdict, verdict_mtime_ms) = has_file(dir.as_deref(), "VERDICT.md");
    let (session_log_name, session_log_age_minutes) = session_activity(projects, cwd.as_deref(), now);
    let tab_session_id = optional_string(&record, "tab_session_id");
    let rate_limited = tab_session_id.as_ref().is_some_and(|session_id| rate_limited_sessions.contains(session_id));
    DispatchEntry {
        slug,
        label: optional_string(&record, "label"), dir: dir.clone(), cwd,
        tab_session_id, tab_id: optional_string(&record, "tab_id"),
        target: optional_string(&record, "target"), status: status.clone(), verify: optional_string(&record, "verify"),
        workstream: optional_string(&record, "workstream"), stage: optional_string(&record, "stage"), ts: optional_string(&record, "ts"),
        has_done, has_ask, has_verdict, done_mtime_ms, ask_mtime_ms, verdict_mtime_ms,
        dir_mtime_ms: dir.as_deref().and_then(|value| mtime_ms(Path::new(value))),
        session_log_name, session_log_age_minutes,
        live_state: live_state(status.as_deref(), has_done, has_ask, rate_limited, session_log_age_minutes),
    }
}

pub fn scan_with_rate_limited_sessions(path: &Path, projects: &Path, rate_limited_sessions: &HashSet<String>) -> io::Result<Vec<DispatchEntry>> {
    let now = SystemTime::now();
    let mut entries: Vec<_> = load_entries(path)?.into_values().map(|record| entry_from_record(record, projects, rate_limited_sessions, now)).collect();
    entries.sort_by(|left, right| left.ts.cmp(&right.ts));
    Ok(entries)
}

pub fn scan(path: &Path, projects: &Path) -> io::Result<Vec<DispatchEntry>> {
    scan_with_rate_limited_sessions(path, projects, &HashSet::new())
}

pub fn scan_default() -> io::Result<Vec<DispatchEntry>> {
    scan_default_with_rate_limited_sessions(&HashSet::new())
}

pub fn scan_default_with_rate_limited_sessions(rate_limited_sessions: &HashSet<String>) -> io::Result<Vec<DispatchEntry>> {
    let Some(path) = ledger_path() else { return Ok(Vec::new()); };
    let Some(projects) = projects_root() else { return Ok(Vec::new()); };
    scan_with_rate_limited_sessions(&path, &projects, rate_limited_sessions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write(path: &Path, bytes: &[u8]) { fs::write(path, bytes).unwrap(); }

    #[test]
    fn slugify_matches_python_regex() {
        assert_eq!(slugify_cwd(r"C:\Users\miyaz\work"), "C--Users-miyaz-work");
        // python: re.sub(r"[^A-Za-z0-9]", "-", cwd) replaces each non-ASCII-alphanumeric
        // code point with one hyphen, so the 8 code points collapse to "C" + 7 hyphens.
        assert_eq!(slugify_cwd(r"C:\仕事\算数"), "C-------");
        assert_eq!(slugify_cwd("a/b.c_1"), "a-b-c-1");
    }

    #[test]
    fn load_merges_last_record_and_skips_bad_lines_bom_and_invalid_utf8() {
        let temp = tempdir().unwrap(); let ledger = temp.path().join("ledger.jsonl");
        write(&ledger, b"\xef\xbb\xbf{\"slug\":\"one\",\"status\":\"open\",\"label\":\"first\"}\nnot json\n\xff\xfe\n{\"slug\":\"one\",\"stage\":\"build\"}\n{\"slug\":\"one\",\"label\":\"last\"}\n");
        let entries = load_entries(&ledger).unwrap(); let one = entries.get("one").unwrap();
        assert_eq!(optional_string(one, "status").as_deref(), Some("open"));
        assert_eq!(optional_string(one, "stage").as_deref(), Some("build"));
        assert_eq!(optional_string(one, "label").as_deref(), Some("last"));
    }

    #[test]
    fn live_state_covers_all_branches() {
        assert_eq!(live_state(Some("closed"), false, false, true, 0.0), "CLOSED");
        assert_eq!(live_state(Some("open"), true, false, true, 0.0), "DONE_NEEDS_REVIEW");
        assert_eq!(live_state(Some("done"), true, false, true, 0.0), "DONE");
        assert_eq!(live_state(Some("open"), false, true, true, 0.0), "ASK");
        assert_eq!(live_state(Some("open"), false, false, false, -1.0), "NO_LOG");
        assert_eq!(live_state(Some("open"), false, false, false, 5.0), "RUNNING");
        assert_eq!(live_state(Some("open"), false, false, true, 5.1), "RATE_LIMITED");
        assert_eq!(live_state(Some("open"), false, false, false, 5.1), "STALL");
    }

    #[test]
    fn scan_missing_ledger_is_empty_and_file_flags_are_read() {
        let temp = tempdir().unwrap(); let projects = temp.path().join("projects"); let ledger = temp.path().join("missing.jsonl");
        assert!(scan(&ledger, &projects).unwrap().is_empty());
        let dispatch = temp.path().join("dispatch"); fs::create_dir(&dispatch).unwrap(); write(&dispatch.join("DONE.md"), b"done"); write(&dispatch.join("ASK.md"), b"ask");
        write(&ledger, format!("{{\"slug\":\"one\",\"status\":\"open\",\"dir\":{}}}", serde_json::to_string(&dispatch.to_string_lossy()).unwrap()).as_bytes());
        let entry = scan(&ledger, &projects).unwrap().pop().unwrap();
        assert!(entry.has_done && entry.has_ask && !entry.has_verdict && entry.done_mtime_ms.is_some());
    }
}
