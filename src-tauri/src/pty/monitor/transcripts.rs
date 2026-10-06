use super::*;

pub(super) fn created_at_or_after(
    metadata: &std::fs::Metadata,
    min_created: Option<std::time::SystemTime>,
) -> bool {
    let Some(min) = min_created else { return true };
    match metadata.created() {
        Ok(created) => created >= min,
        // Creation time unavailable on this filesystem — don't exclude.
        Err(_) => true,
    }
}

pub(super) fn min_created_local_date(min_created: Option<std::time::SystemTime>) -> Option<(i32, u32, u32)> {
    let min_created = min_created?;
    let date: DateTime<Local> = min_created.into();
    Some((date.year(), date.month(), date.day()))
}

pub(super) fn jsonl_head_cwd(path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let lines = std::io::BufReader::new(file).lines().take(32);
    for line in lines.map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(|cwd| cwd.as_str()) {
            if !cwd.trim().is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

pub(super) fn newest_jsonl_candidates_in_dir(
    project_dir: &std::path::Path,
    min_created: Option<std::time::SystemTime>,
) -> Vec<(String, std::path::PathBuf, std::time::SystemTime)> {
    let Ok(entries) = std::fs::read_dir(project_dir) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !created_at_or_after(&meta, min_created) {
            continue;
        }
        let Ok(mtime) = meta.modified() else {
            continue;
        };
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        candidates.push((stem.to_string(), path, mtime));
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.2));
    candidates
}

fn transcript_cli_candidate(path: &std::path::Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else { return false; };
    for line in std::io::BufReader::new(file).lines().take(64).map_while(Result::ok) {
        let Ok(row) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
        if let Some(entrypoint) = row.get("entrypoint").and_then(|v| v.as_str()) {
            return entrypoint == "cli";
        }
    }
    // Older provider logs omit entrypoint. They remain display-only scan candidates.
    true
}

pub(super) fn newest_jsonl_session_id_for_cwd_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    let candidates: Vec<_> = newest_jsonl_candidates_in_dir(project_dir, min_created).into_iter()
        .filter(|(_, path, _)| transcript_cli_candidate(path)).collect();
    let newest = candidates
        .iter()
        .find(|(id, _, _)| !excluded_session_ids.contains(id))
        .map(|(id, _, _)| id.clone());
    let cwd_key = normalize_cwd_key(cwd);
    let mut readable_cwd_count = 0;
    for (session_id, path, _) in candidates {
        if excluded_session_ids.contains(&session_id) {
            continue;
        }
        let Some(candidate_cwd) = jsonl_head_cwd(&path) else {
            continue;
        };
        readable_cwd_count += 1;
        if normalize_cwd_key(&candidate_cwd) == cwd_key {
            return Some(session_id);
        }
    }
    if readable_cwd_count == 0 {
        newest
    } else {
        None
    }
}

/// Detect the active Claude Code session ID by finding the most recently
/// modified `.jsonl` file in `~/.claude/projects/<mangled-cwd>/`,
/// restricted to files created after the agent process started.
pub(super) fn detect_claude_session_id(
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    let mangled = super::super::path_norm::claude_project_key(cwd);
    let project_dir = crate::test_profile::agent_projects_dir("claude")?.join(&mangled);
    if !project_dir.exists() {
        return None;
    }

    detect_claude_session_id_in_dir(&project_dir, cwd, min_created, excluded_session_ids)
}

pub(super) fn detect_claude_session_id_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    newest_jsonl_session_id_for_cwd_in_dir(project_dir, cwd, min_created, excluded_session_ids)
}

pub(super) fn detect_claude_codex_session_id(
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    let mangled = super::super::path_norm::claude_project_key(cwd);
    let project_dir = crate::test_profile::agent_projects_dir("claude-codex")?.join(&mangled);
    if !project_dir.exists() {
        return None;
    }

    detect_claude_codex_session_id_in_dir(&project_dir, cwd, min_created, excluded_session_ids)
}

pub(super) fn detect_claude_codex_session_id_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    newest_jsonl_session_id_for_cwd_in_dir(project_dir, cwd, min_created, excluded_session_ids)
}

pub(super) fn detect_claude_family_session_id(
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<AgentSessionAttribution> {
    detect_claude_family_session_id_with(
        || detect_claude_session_id(cwd, min_created, excluded_session_ids),
        || detect_claude_codex_session_id(cwd, min_created, excluded_session_ids),
    )
}

pub(super) fn detect_claude_family_session_id_with<F, G>(
    detect_claude: F,
    detect_claude_codex: G,
) -> Option<AgentSessionAttribution>
where
    F: FnOnce() -> Option<String>,
    G: FnOnce() -> Option<String>,
{
    detect_claude()
        .map(|session_id| AgentSessionAttribution::new("claude", session_id))
        .or_else(|| {
            detect_claude_codex()
                .map(|session_id| AgentSessionAttribution::new("claude-codex", session_id))
        })
}

#[cfg(test)]
pub(super) fn detect_claude_family_session_id_in_dirs(
    claude_project_dir: &std::path::Path,
    claude_codex_project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<AgentSessionAttribution> {
    detect_claude_family_session_id_with(
        || {
            detect_claude_session_id_in_dir(
                claude_project_dir,
                cwd,
                min_created,
                excluded_session_ids,
            )
        },
        || {
            detect_claude_codex_session_id_in_dir(
                claude_codex_project_dir,
                cwd,
                min_created,
                excluded_session_ids,
            )
        },
    )
}

/// How long a pane's pinned transcript must stay silent before the pane is
/// allowed to look for a successor session.
///
/// Claude Code rolls its session id over mid-run (`/clear`, a resume, a
/// compaction boundary): the old `<id>.jsonl` stops at the instant the new one
/// is created, while the pane mapping — written once at launch — keeps pointing
/// at the file that never grows again. The monitor observes both size and
/// mtime across ticks: Windows may leave mtime frozen while a writer is open.
///
/// The grace period only decides *when* the successor scan runs. A live
/// conversation that happens to be quiet (one long tool call) has no successor
/// file, so the scan returns nothing and the pin stays exactly where it was.
pub(super) const AGENT_TRANSCRIPT_SILENCE_GRACE: Duration = Duration::from_secs(60);

/// A rollover creates the successor at the same instant the predecessor stops,
/// so the successor scan floors "created at or after" at that instant. The
/// slack absorbs flush ordering and filesystem timestamp granularity while
/// still rejecting a transcript that was already being written *while* the
/// pinned conversation was alive — that one belongs to another pane's lane.
pub(super) const SUCCESSOR_CREATION_SLACK: Duration = Duration::from_secs(5);

/// Path of the transcript a Claude-family session id maps to, or `None` when
/// the id is not a session id we could have written (defensive: mapping files
/// are plain text and must never be able to point outside the project dir).
pub(super) fn claude_family_transcript_path(
    agent_kind: &str,
    cwd: &str,
    session_id: &str,
) -> Option<std::path::PathBuf> {
    if !is_uuid_like(session_id) {
        return None;
    }
    let mangled = super::super::path_norm::claude_project_key(cwd);
    let project_dir = crate::test_profile::agent_projects_dir(agent_kind)?.join(mangled);
    Some(project_dir.join(format!("{session_id}.jsonl")))
}

#[derive(Default)]
pub(super) struct TranscriptActivityTracker {
    observed: HashMap<std::path::PathBuf, TranscriptActivity>,
}

struct TranscriptActivity {
    len: u64,
    modified: Option<std::time::SystemTime>,
    last_write: std::time::SystemTime,
    last_seen: std::time::SystemTime,
    successor_floor: std::time::SystemTime,
}

impl TranscriptActivityTracker {
    pub(super) fn last_write(
        &mut self,
        kind: &str,
        cwd: &str,
        session_id: &str,
        now: std::time::SystemTime,
    ) -> Option<(std::time::SystemTime, std::time::SystemTime)> {
        let path = claude_family_transcript_path(kind, cwd, session_id)?;
        let metadata = std::fs::metadata(&path).ok()?;
        Some(self.observe(&path, &metadata, now))
    }

    fn observe(
        &mut self,
        path: &std::path::Path,
        metadata: &std::fs::Metadata,
        now: std::time::SystemTime,
    ) -> (std::time::SystemTime, std::time::SystemTime) {
        let modified = metadata.modified().ok();
        // Windows can leave mtime unchanged while an open writer appends.
        // Require observed silence, including on the first encounter, before
        // permitting a pane to abandon its pinned transcript.
        let entry = self.observed.entry(path.to_path_buf()).or_insert(TranscriptActivity {
            len: metadata.len(), modified, last_write: now, last_seen: now,
            successor_floor: modified.unwrap_or(now).min(now),
        });
        if entry.len != metadata.len() || entry.modified != modified {
            entry.last_write = now;
            // The append happened after the previous observation, not necessarily
            // at this poll. Using now would exclude a successor already created
            // between those two polls.
            entry.successor_floor = entry.last_seen;
        }
        entry.len = metadata.len();
        entry.modified = modified;
        entry.last_seen = now;
        (entry.last_write, entry.successor_floor)
    }

    pub(super) fn retain_recent(&mut self, now: std::time::SystemTime) {
        self.observed.retain(|_, entry| {
            now.duration_since(entry.last_seen)
                .map_or(true, |elapsed| elapsed <= AGENT_TRANSCRIPT_SILENCE_GRACE * 2)
        });
    }
}

/// `None` (no transcript on disk) is deliberately *not* silent: an agent that
/// has not written its first line yet proves nothing about a rollover, and
/// calling it silent would let a brand-new pane go hunting for a session and
/// adopt a neighbour's freshly created one.
pub(super) fn transcript_is_silent(
    last_write: Option<std::time::SystemTime>,
    now: std::time::SystemTime,
) -> bool {
    let Some(last_write) = last_write else {
        return false;
    };
    now.duration_since(last_write)
        .is_ok_and(|elapsed| elapsed >= AGENT_TRANSCRIPT_SILENCE_GRACE)
}

/// Raise the successor scan's "created at or after" floor to the moment the
/// pinned transcript went silent, so the scan can only ever return a file that
/// did not exist while the pinned conversation was still being written.
pub(super) fn successor_scan_floor(
    agent_min_created: Option<std::time::SystemTime>,
    pinned_last_write: Option<std::time::SystemTime>,
) -> Option<std::time::SystemTime> {
    let Some(pinned_last_write) = pinned_last_write else {
        return agent_min_created;
    };
    let floor = pinned_last_write
        .checked_sub(SUCCESSOR_CREATION_SLACK)
        .unwrap_or(pinned_last_write);
    Some(match agent_min_created {
        Some(agent_min_created) => agent_min_created.max(floor),
        None => floor,
    })
}

pub(super) use super::super::path_norm::normalize_cwd_key;

pub(super) fn codex_session_meta(path: &std::path::Path) -> Option<(String, String)> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return None,
    };
    let mut lines = std::io::BufReader::new(file).lines();
    let Some(Ok(line)) = lines.next() else {
        return None;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
        return None;
    };
    let payload = value.get("payload")?;
    // Newer child/exec rollouts may share the main pane's CWD. They are not
    // interactive pane identities, even when their mtime wins the scan.
    let source = payload.get("source");
    let child_or_exec_source = source.is_some_and(|source| {
        matches!(source.as_str(), Some("subagent" | "exec"))
            || source
                .as_object()
                .is_some_and(|source| source.contains_key("subagent"))
    });
    if child_or_exec_source
        || payload
            .get("parent_thread_id")
            .is_some_and(|parent| !parent.is_null())
        || payload
            .get("thread_source")
            .and_then(|source| source.as_str())
            == Some("subagent")
        || payload
            .get("originator")
            .and_then(|originator| originator.as_str())
            == Some("codex_exec")
    {
        return None;
    }
    let id = payload.get("id").and_then(|id| id.as_str())?;
    let cwd = payload.get("cwd").and_then(|cwd| cwd.as_str())?;
    if id.trim().is_empty() {
        return None;
    }
    Some((id.to_string(), cwd.to_string()))
}

pub(super) fn codex_session_id_for_cwd(path: &std::path::Path, cwd_key: &str) -> Option<String> {
    let (payload_id, payload_cwd) = codex_session_meta(path)?;
    if normalize_cwd_key(&payload_cwd) == cwd_key {
        Some(payload_id)
    } else {
        None
    }
}

pub(super) fn visit_codex_sessions_dir(
    dir: &std::path::Path,
    cwd_key: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
    best: &mut Option<(String, std::time::SystemTime)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if is_codex_date_dir_before_min(&path, min_created) {
                continue;
            }
            visit_codex_sessions_dir(&path, cwd_key, min_created, excluded_session_ids, best);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !created_at_or_after(&metadata, min_created) {
            continue;
        }
        let Some(session_id) = codex_session_id_for_cwd(&path, cwd_key) else {
            continue;
        };
        if excluded_session_ids.contains(&session_id) {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if best.is_none() || modified > best.as_ref().unwrap().1 {
            *best = Some((session_id, modified));
        }
    }
}

pub(super) fn parse_date_component(value: &str, min: u32, max: u32) -> Option<u32> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parsed = value.parse::<u32>().ok()?;
    if (min..=max).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

pub(super) fn path_component_string(path: &std::path::Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

pub(super) fn is_codex_date_dir_before_min(
    dir: &std::path::Path,
    min_created: Option<std::time::SystemTime>,
) -> bool {
    let Some((min_year, min_month, min_day)) = min_created_local_date(min_created) else {
        return false;
    };
    let Some(name) = path_component_string(dir) else {
        return false;
    };

    if let Some(month_dir) = dir.parent() {
        if let (Some(day), Some(month_name)) = (
            parse_date_component(&name, 1, 31),
            path_component_string(month_dir),
        ) {
            if let Some(year_dir) = month_dir.parent() {
                if let (Some(month), Some(year_name)) = (
                    parse_date_component(&month_name, 1, 12),
                    path_component_string(year_dir),
                ) {
                    if let Some(year) = parse_date_component(&year_name, 1970, 9999) {
                        return (year as i32, month, day) < (min_year, min_month, min_day);
                    }
                }
            }
        }

        if let Some(year_name) = path_component_string(month_dir) {
            if let (Some(month), Some(year)) = (
                parse_date_component(&name, 1, 12),
                parse_date_component(&year_name, 1970, 9999),
            ) {
                return (year as i32, month) < (min_year, min_month);
            }
        }
    }

    if let Some(year) = parse_date_component(&name, 1970, 9999) {
        return (year as i32) < min_year;
    }

    false
}

pub(super) fn detect_codex_session_id(
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    if crate::test_profile::is_active() {
        return None;
    }
    let home = dirs::home_dir()?;
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() {
        return None;
    }
    let cwd_key = normalize_cwd_key(cwd);
    let mut best: Option<(String, std::time::SystemTime)> = None;
    visit_codex_sessions_dir(
        &sessions_dir,
        &cwd_key,
        min_created,
        excluded_session_ids,
        &mut best,
    );
    best.map(|(id, _)| id)
}

#[cfg(test)]
mod codex_identity_tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs::File;
    use std::time::{Duration, UNIX_EPOCH};

    fn write_rollout(
        dir: &std::path::Path,
        name: &str,
        extra: Value,
        modified: u64,
    ) -> std::path::PathBuf {
        let path = dir.join(format!("{name}.jsonl"));
        let mut payload =
            json!({"id": name, "cwd": "C:\\work", "source": "cli", "originator": "codex-tui"});
        for (key, value) in extra.as_object().unwrap() {
            payload[key] = value.clone();
        }
        let line = json!({"type": "session_meta", "payload": payload}).to_string();
        std::fs::write(&path, format!("{line}\n")).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(modified))
            .unwrap();
        path
    }

    fn child_and_exec_headers() -> Vec<Value> {
        vec![
            json!({"source": "subagent"}),
            json!({"source": {"subagent": {"thread_spawn": {"parent_thread_id": "main", "depth": 1}}}}),
            json!({"parent_thread_id": "main"}),
            json!({"thread_source": "subagent"}),
            json!({"originator": "codex_exec", "thread_source": "user"}),
            json!({"source": "exec"}),
        ]
    }

    #[test]
    fn codex_meta_excludes_child_and_exec_rollout_headers() {
        let dir = tempfile::tempdir().unwrap();
        for (index, extra) in child_and_exec_headers().into_iter().enumerate() {
            let path = write_rollout(dir.path(), &format!("child-{index}"), extra, 1_700_000_001);
            assert_eq!(codex_session_meta(&path), None, "{index}");
            assert_eq!(
                codex_session_id_for_cwd(&path, &normalize_cwd_key(r"C:\work")),
                None,
                "{index}"
            );
        }
        let path = write_rollout(
            dir.path(),
            "main",
            json!({"parent_thread_id": null}),
            1_700_000_000,
        );
        assert_eq!(
            codex_session_meta(&path),
            Some(("main".to_string(), r"C:\work".to_string()))
        );
    }

    #[test]
    fn newer_subagent_and_exec_rollouts_never_replace_main_in_same_cwd_t8() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("2026/10/02");
        std::fs::create_dir_all(&day).unwrap();
        write_rollout(&day, "main", json!({}), 1_700_000_000);
        for (index, extra) in child_and_exec_headers().into_iter().enumerate() {
            write_rollout(
                &day,
                &format!("newer-child-{index}"),
                extra,
                1_700_000_010 + index as u64,
            );
        }
        let cwd_key = normalize_cwd_key(r"c:/work/");
        let mut best = None;
        visit_codex_sessions_dir(dir.path(), &cwd_key, None, &HashSet::new(), &mut best);
        assert_eq!(best.as_ref().map(|(id, _)| id.as_str()), Some("main"));

        let mut excluded_best = None;
        visit_codex_sessions_dir(
            dir.path(),
            &cwd_key,
            None,
            &HashSet::from(["main".to_string()]),
            &mut excluded_best,
        );
        assert!(excluded_best.is_none());
    }

    #[test]
    fn codex_scans_with_only_child_or_exec_rollouts_return_none() {
        let dir = tempfile::tempdir().unwrap();
        for (index, extra) in child_and_exec_headers().into_iter().enumerate() {
            write_rollout(
                dir.path(),
                &format!("child-{index}"),
                extra,
                1_700_000_010 + index as u64,
            );
        }
        let mut best = None;
        visit_codex_sessions_dir(
            dir.path(),
            &normalize_cwd_key(r"C:\work"),
            None,
            &HashSet::new(),
            &mut best,
        );
        assert!(best.is_none());
    }

    #[test]
    fn codex_scans_keep_cwd_creation_floor_and_exclusion_rules() {
        let dir = tempfile::tempdir().unwrap();
        write_rollout(dir.path(), "older-main", json!({}), 1_700_000_000);
        write_rollout(
            dir.path(),
            "newer-main",
            json!({"originator": "codex-cli"}),
            1_700_000_010,
        );
        write_rollout(
            dir.path(),
            "other-cwd",
            json!({"cwd": "C:\\elsewhere"}),
            1_700_000_020,
        );
        let cwd_key = normalize_cwd_key(r"C:\work");
        let mut best = None;
        visit_codex_sessions_dir(dir.path(), &cwd_key, None, &HashSet::new(), &mut best);
        assert_eq!(best.as_ref().map(|(id, _)| id.as_str()), Some("newer-main"));
        let mut excluded_best = None;
        visit_codex_sessions_dir(
            dir.path(),
            &cwd_key,
            None,
            &HashSet::from(["newer-main".to_string()]),
            &mut excluded_best,
        );
        assert_eq!(
            excluded_best.as_ref().map(|(id, _)| id.as_str()),
            Some("older-main")
        );
        let mut after_floor = None;
        visit_codex_sessions_dir(
            dir.path(),
            &cwd_key,
            Some(std::time::SystemTime::now() + Duration::from_secs(60)),
            &HashSet::new(),
            &mut after_floor,
        );
        assert!(after_floor.is_none());
    }
}

#[cfg(test)]
mod activity_tests {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn appends_with_a_frozen_mtime_are_not_silent_and_keep_a_safe_successor_floor() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, b"seed").unwrap();
        let frozen = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let now = frozen + Duration::from_secs(600);
        File::options().write(true).open(&path).unwrap().set_modified(frozen).unwrap();
        let mut tracker = TranscriptActivityTracker::default();
        let first = tracker.observe(&path, &std::fs::metadata(&path).unwrap(), now);
        assert!(!transcript_is_silent(Some(first.0), now));
        for step in 1..=8 {
            let mut file = OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(b"more").unwrap();
            file.set_modified(frozen).unwrap();
            let at = now + Duration::from_secs(step * 10);
            let observation = tracker.observe(&path, &std::fs::metadata(&path).unwrap(), at);
            assert!(!transcript_is_silent(Some(observation.0), at));
            assert_eq!(observation.1, at - Duration::from_secs(10));
        }
        let quiet = now + Duration::from_secs(140);
        let observation = tracker.observe(&path, &std::fs::metadata(&path).unwrap(), quiet);
        assert!(transcript_is_silent(Some(observation.0), quiet));
        tracker.retain_recent(quiet + AGENT_TRANSCRIPT_SILENCE_GRACE * 3);
        assert!(tracker.observed.is_empty());
    }
}
