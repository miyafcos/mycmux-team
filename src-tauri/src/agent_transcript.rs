//! Shared transcript discovery and import helpers.

use chrono::Local;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::commands::online::SavepointAgentKind;
use crate::commands::online_publish::{norm_slashes, read_codex_session_meta};
use crate::pty::path_norm::claude_project_key;

fn latest_transcript_in(project_dir: &Path) -> Option<(PathBuf, String)> {
    let entries = fs::read_dir(project_dir).ok()?;
    let mut latest = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if latest.as_ref().is_none_or(|(current, _)| modified > *current) {
            latest = Some((modified, path));
        }
    }
    let (_, path) = latest?;
    Some((path.clone(), path.file_stem()?.to_string_lossy().into_owned()))
}

pub(crate) fn locate_claude_transcript(
    projects_dir: &Path,
    cwd: &str,
    session: Option<&str>,
) -> Result<(PathBuf, String), String> {
    let project_dir = projects_dir.join(crate::commands::online::sanitize_project_dir(cwd));
    if let Some(session) = session {
        let candidate = project_dir.join(format!("{session}.jsonl"));
        if candidate.is_file() {
            return Ok((candidate, session.to_string()));
        }
        if let Ok(entries) = fs::read_dir(projects_dir) {
            for entry in entries.flatten() {
                let fallback = entry.path().join(format!("{session}.jsonl"));
                if fallback.is_file() {
                    return Ok((fallback, session.to_string()));
                }
            }
        }
        if let Some(found) = latest_transcript_in(&project_dir) {
            return Ok(found);
        }
        return Err(format!("Session transcript {session}.jsonl not found under {}", projects_dir.display()));
    }
    latest_transcript_in(&project_dir)
        .ok_or_else(|| format!("No session transcript found in {}", project_dir.display()))
}

pub(crate) fn locate_claude_transcript_exact(
    projects_dir: &Path,
    cwd: &str,
    session: &str,
) -> Result<PathBuf, String> {
    let candidate = projects_dir.join(claude_project_key(cwd)).join(format!("{session}.jsonl"));
    if candidate.is_file() {
        return Ok(candidate);
    }
    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            let fallback = entry.path().join(format!("{session}.jsonl"));
            if fallback.is_file() {
                return Ok(fallback);
            }
        }
    }
    Err(format!("Session transcript {session}.jsonl not found under {}", projects_dir.display()))
}

fn collect_codex_transcript_paths(root: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() { continue; }
        if file_type.is_dir() {
            collect_codex_transcript_paths(&path, paths);
        } else if file_type.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            paths.push(path);
        }
    }
}

pub(crate) fn locate_codex_transcript(
    sessions_root: &Path,
    cwd: &str,
    session: Option<&str>,
) -> Result<(PathBuf, String), String> {
    if let Some(session) = session {
        Uuid::parse_str(session).map_err(|_| "Codex session id is invalid".to_string())?;
    }
    let mut paths = Vec::new();
    collect_codex_transcript_paths(sessions_root, &mut paths);
    if let Some(session) = session {
        let suffix = format!("-{session}.jsonl");
        for path in paths.iter().filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(&suffix))) {
            let Ok(meta) = read_codex_session_meta(path) else { continue };
            if meta.id == session && meta.root_session_id == session {
                return Ok((path.clone(), session.to_string()));
            }
        }
        return Err(format!("Codex session transcript {session} not found under {}", sessions_root.display()));
    }
    let expected_cwd = norm_slashes(cwd).to_lowercase();
    let mut candidates = paths.into_iter().filter_map(|path| {
        let meta = read_codex_session_meta(&path).ok()?;
        if meta.id != meta.root_session_id || meta.cwd.as_deref().map(norm_slashes).map(|value| value.to_lowercase()).as_deref() != Some(expected_cwd.as_str()) {
            return None;
        }
        Some((fs::metadata(&path).and_then(|value| value.modified()).ok()?, path, meta.id))
    }).collect::<Vec<_>>();
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    candidates.into_iter().next().map(|(_, path, id)| (path, id)).ok_or_else(|| format!("No Codex session transcript found in {}", sessions_root.display()))
}

pub(crate) fn locate_agent_transcript(
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

/// Copy JSONL records, dropping only a torn trailing write.
///
/// A live transcript can be mid-write when we clone it, so the final line may be
/// a partial JSON object. Such a fragment must not reach the clone. A final line
/// that merely lacks its newline is NOT torn — savepoint bundles are written that
/// way at rest, and dropping it would silently lose the last conversation turn.
/// Parseability, not the newline, is what separates the two cases.
fn copy_complete_jsonl_records<R: BufRead, W: Write>(reader: &mut R, writer: &mut W) -> Result<(), String> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|error| format!("Failed to read transcript: {error}"))? == 0 {
            return Ok(());
        }
        let terminated = line.ends_with('\n');
        if serde_json::from_str::<serde_json::Value>(line.trim_end()).is_ok() {
            writer.write_all(line.as_bytes()).map_err(|error| format!("Failed to write transcript: {error}"))?;
            if !terminated {
                writer.write_all(b"\n").map_err(|error| format!("Failed to write transcript: {error}"))?;
            }
        }
        if !terminated {
            return Ok(());
        }
    }
}

pub(crate) fn copy_claude_transcript(transcript: &Path, target: &Path) -> Result<(), String> {
    let source = fs::File::open(transcript).map_err(|error| format!("Failed to open {}: {error}", transcript.display()))?;
    let mut reader = BufReader::new(source);
    crate::util::atomic_write::AtomicWrite::new("Claude transcript clone", format!("Failed to install {}", target.display()))
        .create_parents()
        .write_with(target, |temp_file| copy_complete_jsonl_records(&mut reader, temp_file))
}

pub(crate) fn import_codex_transcript(transcript: &Path, sessions_root: &Path, expected_session_id: &str, resolved_cwd: &str) -> Result<String, String> {
    Uuid::parse_str(expected_session_id).map_err(|_| "Codex savepoint session id is invalid".to_string())?;
    let source = fs::File::open(transcript).map_err(|error| format!("Failed to open {}: {error}", transcript.display()))?;
    let mut reader = BufReader::new(source);
    let mut first_line = String::new();
    // Only emptiness is checked here: a header that is torn or malformed fails the
    // parse below with a clearer message, and a header that simply lacks its newline
    // (single-line bundle) is still valid.
    if reader.read_line(&mut first_line).map_err(|error| format!("Failed to read {}: {error}", transcript.display()))? == 0 {
        return Err("Codex savepoint transcript is empty".to_string());
    }
    let mut session_meta: serde_json::Value = serde_json::from_str(first_line.trim_end()).map_err(|error| format!("Invalid Codex session metadata: {error}"))?;
    if session_meta.get("type").and_then(serde_json::Value::as_str) != Some("session_meta") {
        return Err("Codex savepoint transcript does not start with session_meta".to_string());
    }
    let payload = session_meta.get_mut("payload").and_then(serde_json::Value::as_object_mut).ok_or_else(|| "Codex session_meta payload is invalid".to_string())?;
    let source_id = payload.get("id").and_then(serde_json::Value::as_str).ok_or_else(|| "Codex savepoint session id is missing".to_string())?;
    let root_session_id = payload.get("session_id").and_then(serde_json::Value::as_str).ok_or_else(|| "Codex savepoint root session id is missing".to_string())?;
    if source_id != expected_session_id || root_session_id != expected_session_id {
        return Err("Codex savepoint transcript identity does not match its manifest".to_string());
    }
    let import_id = Uuid::new_v4().to_string();
    payload.insert("id".to_string(), serde_json::Value::String(import_id.clone()));
    payload.insert("session_id".to_string(), serde_json::Value::String(import_id.clone()));
    payload.insert("cwd".to_string(), serde_json::Value::String(resolved_cwd.to_string()));
    let now = Local::now();
    let target = sessions_root.join(now.format("%Y").to_string()).join(now.format("%m").to_string()).join(now.format("%d").to_string()).join(format!("rollout-{}-{import_id}.jsonl", now.format("%Y-%m-%dT%H-%M-%S")));
    crate::util::atomic_write::AtomicWrite::new("Codex transcript import", format!("Failed to install {}", target.display()))
        .create_parents()
        .write_with(&target, |temp_file| {
            serde_json::to_writer(&mut *temp_file, &session_meta).map_err(|error| format!("Failed to write Codex session metadata: {error}"))?;
            temp_file.write_all(b"\n").map_err(|error| format!("Failed to write Codex transcript import: {error}"))?;
            copy_complete_jsonl_records(&mut reader, temp_file)
        })?;
    Ok(import_id)
}
