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

pub(super) fn newest_jsonl_session_id_for_cwd_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    let candidates = newest_jsonl_candidates_in_dir(project_dir, min_created);
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
    let home = dirs::home_dir()?;
    let mangled = super::super::path_norm::claude_project_key(cwd);
    let project_dir = home.join(".claude").join("projects").join(&mangled);
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
    let home = dirs::home_dir()?;
    let mangled = super::super::path_norm::claude_project_key(cwd);
    let project_dir = home
        .join(".claude-codex")
        .join("config")
        .join("projects")
        .join(&mangled);
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
