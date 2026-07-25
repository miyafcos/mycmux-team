/// Newest .jsonl transcript in a project dir, with its session id.
fn latest_transcript_in(project_dir: &Path) -> Option<(PathBuf, String)> {
    let entries = fs::read_dir(project_dir).ok()?;
    let mut latest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if latest
            .as_ref()
            .is_none_or(|(current, _)| modified > *current)
        {
            latest = Some((modified, path));
        }
    }
    let (_, path) = latest?;
    let session_id = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())?;
    Some((path, session_id))
}

fn locate_claude_transcript(
    projects_dir: &Path,
    cwd: &str,
    session: Option<&str>,
) -> Result<(PathBuf, String), String> {
    let project_dir = projects_dir.join(sanitize_project_dir(cwd));
    if let Some(session) = session {
        let candidate = project_dir.join(format!("{session}.jsonl"));
        if candidate.is_file() {
            return Ok((candidate, session.to_string()));
        }
        // cwd の sanitize 結果と実際の置き場所がずれた場合の保険: 全 project を横断検索
        if let Ok(entries) = fs::read_dir(projects_dir) {
            for entry in entries.flatten() {
                let fallback = entry.path().join(format!("{session}.jsonl"));
                if fallback.is_file() {
                    return Ok((fallback, session.to_string()));
                }
            }
        }
        // The recorded id can go stale while the pane still has a real
        // conversation: claude's in-app /resume (or the bare --resume
        // picker) switches the live session away from the id in argv and
        // tab markers (observed 2026-07-12: argv --session-id had no jsonl
        // while the pane was actively writing another session). Fall back
        // to the newest transcript for this cwd; the caller warns with the
        // id actually published.
        if let Some(found) = latest_transcript_in(&project_dir) {
            return Ok(found);
        }
        return Err(format!(
            "Session transcript {session}.jsonl not found under {}",
            projects_dir.display()
        ));
    }

    let entries = fs::read_dir(&project_dir)
        .map_err(|error| format!("Failed to scan {}: {error}", project_dir.display()))?;
    let mut latest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if latest
            .as_ref()
            .is_none_or(|(current, _)| modified > *current)
        {
            latest = Some((modified, path));
        }
    }
    let (_, path) = latest
        .ok_or_else(|| format!("No session transcript found in {}", project_dir.display()))?;
    let session_id = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .ok_or_else(|| format!("Invalid transcript file name: {}", path.display()))?;
    Ok((path, session_id))
}

/// tmp_dir を target_dir へ入れ替える (受け手が読取り中でも壊れないように)。
fn collect_codex_transcript_paths(root: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_codex_transcript_paths(&path, paths);
        } else if file_type.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            paths.push(path);
        }
    }
}

fn locate_codex_transcript(
    sessions_root: &Path,
    cwd: &str,
    session: Option<&str>,
) -> Result<(PathBuf, String), String> {
    if let Some(session) = session {
        uuid::Uuid::parse_str(session).map_err(|_| "Codex session id is invalid".to_string())?;
    }
    let mut paths = Vec::new();
    collect_codex_transcript_paths(sessions_root, &mut paths);
    if let Some(session) = session {
        let filename_suffix = format!("-{session}.jsonl");
        for path in paths.iter().filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&filename_suffix))
        }) {
            let Ok(meta) = read_codex_session_meta(path) else {
                continue;
            };
            if meta.id == session && meta.root_session_id == session {
                return Ok((path.clone(), session.to_string()));
            }
        }
        return Err(format!(
            "Codex session transcript {session} not found under {}",
            sessions_root.display()
        ));
    }

    let expected_cwd = norm_slashes(cwd).to_lowercase();
    let mut candidates = paths
        .into_iter()
        .filter_map(|path| {
            let meta = read_codex_session_meta(&path).ok()?;
            if meta.id != meta.root_session_id
                || meta
                    .cwd
                    .as_deref()
                    .map(norm_slashes)
                    .map(|value| value.to_lowercase())
                    .as_deref()
                    != Some(expected_cwd.as_str())
            {
                return None;
            }
            let modified = fs::metadata(&path)
                .and_then(|value| value.modified())
                .ok()?;
            Some((modified, path, meta.id))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    candidates
        .into_iter()
        .next()
        .map(|(_, path, session_id)| (path, session_id))
        .ok_or_else(|| {
            format!(
                "No Codex session transcript found in {}",
                sessions_root.display()
            )
        })
}

fn locate_agent_transcript(
    transcript_root: &Path,
    kind: SavepointAgentKind,
    cwd: &str,
    session: Option<&str>,
) -> Result<(PathBuf, String), String> {
    match kind {
        SavepointAgentKind::Claude => locate_claude_transcript(transcript_root, cwd, session),
        SavepointAgentKind::Codex => locate_codex_transcript(transcript_root, cwd, session),
    }
}

fn digest_agent_transcript(
    kind: SavepointAgentKind,
    transcript: &Path,
) -> Result<SessionDigest, String> {
    match kind {
        SavepointAgentKind::Claude => digest_claude_transcript(transcript),
        SavepointAgentKind::Codex => digest_codex_transcript(transcript),
    }
}
