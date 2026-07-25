fn atomic_swap_dir(tmp_dir: &Path, target_dir: &Path) -> Result<(), String> {
    let parent = target_dir
        .parent()
        .ok_or_else(|| "Bundle parent directory not found".to_string())?;
    let old_dir = parent.join(format!(
        "{}.old-{}-{}",
        target_dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    if target_dir.exists() {
        fs::rename(target_dir, &old_dir)
            .map_err(|error| format!("Failed to stage old bundle: {error}"))?;
    }
    if let Err(error) = fs::rename(tmp_dir, target_dir) {
        if old_dir.exists() {
            let _ = fs::rename(&old_dir, target_dir);
        }
        return Err(format!("Failed to swap in new bundle: {error}"));
    }
    if old_dir.exists() {
        let _ = fs::remove_dir_all(&old_dir);
    }
    Ok(())
}

fn atomic_create_dir(tmp_dir: &Path, target_dir: &Path) -> Result<bool, String> {
    if target_dir.exists() {
        return Ok(false);
    }
    match fs::rename(tmp_dir, target_dir) {
        Ok(()) => Ok(true),
        Err(_error) if target_dir.exists() => Ok(false),
        Err(error) => Err(format!("Failed to create immutable record: {error}")),
    }
}

fn safe_final_records_dir(online_dir: &Path, create: bool) -> Result<Option<PathBuf>, String> {
    let online_root = fs::canonicalize(online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    let candidate = online_dir.join(FINAL_RECORDS_DIR);
    if candidate.exists() {
        if is_link_or_reparse_point(&candidate) || !candidate.is_dir() {
            return Err(format!(
                "Final records path must be a real directory: {}",
                candidate.display()
            ));
        }
    } else if create {
        fs::create_dir(&candidate)
            .map_err(|error| format!("Failed to create {}: {error}", candidate.display()))?;
    } else {
        return Ok(None);
    }
    let records_root = fs::canonicalize(&candidate)
        .map_err(|error| format!("Failed to resolve {}: {error}", candidate.display()))?;
    if records_root.parent() != Some(online_root.as_path()) || is_link_or_reparse_point(&candidate)
    {
        return Err(format!(
            "Final records path escapes {}",
            online_root.display()
        ));
    }
    Ok(Some(candidate))
}

fn write_bundle_temp(
    tmp_dir: &Path,
    manifest: &Value,
    handoff_md: &str,
    jsonl_path: &Path,
) -> Result<(), String> {
    fs::create_dir_all(tmp_dir.join("transcript"))
        .map_err(|error| format!("Failed to create bundle temp dir: {error}"))?;
    let manifest_json = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("Failed to serialize manifest: {error}"))?;
    fs::write(tmp_dir.join("manifest.json"), manifest_json)
        .map_err(|error| format!("Failed to write manifest: {error}"))?;
    fs::write(tmp_dir.join("handoff.md"), handoff_md)
        .map_err(|error| format!("Failed to write handoff.md: {error}"))?;
    let transcript_name = jsonl_path
        .file_name()
        .ok_or_else(|| format!("Invalid transcript path: {}", jsonl_path.display()))?;
    fs::copy(jsonl_path, tmp_dir.join("transcript").join(transcript_name))
        .map_err(|error| format!("Failed to copy transcript: {error}"))?;
    Ok(())
}

fn lifecycle_from_manifest(manifest: Option<&Value>) -> SavepointLifecycle {
    manifest
        .and_then(|value| value.get("lifecycle"))
        .and_then(|value| serde_json::from_value::<SavepointLifecycle>(value.clone()).ok())
        .unwrap_or_default()
        .normalized()
}

fn read_head_manifest_with_recovery(head_dir: &Path) -> Option<Value> {
    if let Ok(manifest) = read_json::<Value>(&head_dir.join("manifest.json")) {
        return Some(manifest);
    }
    let parent = head_dir.parent()?;
    let prefix = format!("{}.old-", head_dir.file_name()?.to_string_lossy());
    let mut candidates = fs::read_dir(parent)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(&prefix) || !path.is_dir() || is_link_or_reparse_point(&path) {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()?;
            Some((modified, path))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    candidates.into_iter().find_map(|(_, path)| {
        let manifest = read_json::<Value>(&path.join("manifest.json")).ok()?;
        lifecycle_from_manifest(Some(&manifest))
            .checkpoint_id
            .is_some()
            .then_some(manifest)
    })
}

fn validate_final_record(
    manifest: &Value,
    target_dir: &Path,
    agent_kind: SavepointAgentKind,
    session_id: &str,
    checkpoint_id: &str,
) -> Result<SavepointLifecycle, String> {
    let lifecycle = lifecycle_from_manifest(Some(manifest));
    let generic_kind = manifest.get("agent_kind").and_then(Value::as_str);
    let generic_id = manifest.get("agent_session_id").and_then(Value::as_str);
    let legacy_id = manifest.get("claude_session_id").and_then(Value::as_str);
    let identity_matches = match agent_kind {
        SavepointAgentKind::Claude => {
            (generic_kind.is_none() && generic_id.is_none() && legacy_id == Some(session_id))
                || (generic_kind == Some("claude")
                    && generic_id == Some(session_id)
                    && legacy_id == Some(session_id))
        }
        SavepointAgentKind::Codex => {
            generic_kind == Some("codex") && generic_id == Some(session_id) && legacy_id.is_none()
        }
    };
    if !identity_matches
        || lifecycle.status != SavepointLifecycleStatus::Closed
        || !lifecycle.final_checkpoint
        || lifecycle.checkpoint_id.as_deref() != Some(checkpoint_id)
    {
        return Err(format!(
            "Immutable record identity mismatch: {}",
            target_dir.display()
        ));
    }
    Ok(lifecycle)
}

fn find_bundle_transcript(bundle_dir: &Path) -> Result<PathBuf, String> {
    let transcript_dir = bundle_dir.join("transcript");
    let mut transcripts = fs::read_dir(&transcript_dir)
        .map_err(|error| format!("Failed to scan {}: {error}", transcript_dir.display()))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect::<Vec<_>>();
    transcripts.sort();
    transcripts
        .into_iter()
        .next()
        .ok_or_else(|| format!("No transcript JSONL found in {}", transcript_dir.display()))
}

fn write_head_from_final_record(final_dir: &Path, head_dir: &Path) -> Result<Value, String> {
    let final_manifest: Value = read_json(&final_dir.join("manifest.json"))?;
    let mut head_lifecycle = lifecycle_from_manifest(Some(&final_manifest));
    let current_head = read_json::<Value>(&head_dir.join("manifest.json")).ok();
    let current_head_id = lifecycle_from_manifest(current_head.as_ref()).checkpoint_id;
    let replaces_trashed_parent = current_head.as_ref().is_some_and(|manifest| {
        manifest
            .get(TRASHED_FINAL_CHECKPOINT_FIELD)
            .and_then(Value::as_str)
            == current_head_id.as_deref()
            && current_head_id.as_deref() == head_lifecycle.parent_checkpoint_id.as_deref()
    });
    if current_head.is_some()
        && current_head_id.is_some()
        && current_head_id != head_lifecycle.checkpoint_id
        && !replaces_trashed_parent
    {
        return Ok(final_manifest);
    }

    head_lifecycle.final_checkpoint = false;
    let mut head_manifest = final_manifest.clone();
    let object = head_manifest
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", final_dir.display()))?;
    object.insert(
        "lifecycle".to_string(),
        serde_json::to_value(head_lifecycle)
            .map_err(|error| format!("Failed to serialize lifecycle: {error}"))?,
    );
    let handoff_md = fs::read_to_string(final_dir.join("handoff.md"))
        .map_err(|error| format!("Failed to read final handoff: {error}"))?;
    let transcript = find_bundle_transcript(final_dir)?;
    let parent = head_dir
        .parent()
        .ok_or_else(|| "Bundle parent directory not found".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let head_tmp = parent.join(format!(
        ".{}.tmp-{}",
        head_dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    let outcome = (|| -> Result<(), String> {
        write_bundle_temp(&head_tmp, &head_manifest, &handoff_md, &transcript)?;
        atomic_swap_dir(&head_tmp, head_dir)
    })();
    if head_tmp.exists() {
        let _ = fs::remove_dir_all(&head_tmp);
    }
    outcome?;
    Ok(final_manifest)
}
