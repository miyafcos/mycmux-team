fn resolve_join_cwd(cwd: &str, dropbox_root: Option<&str>, home: &Path) -> (PathBuf, bool) {
    let candidate = if let Some(suffix) = cwd.strip_prefix(DROPBOX_TOKEN) {
        dropbox_root
            .map(|root| expand_home_path(root, home).join(suffix.trim_start_matches(['/', '\\'])))
    } else {
        let path = PathBuf::from(cwd);
        path.is_absolute().then_some(path)
    };

    match candidate {
        Some(path) if path.is_dir() => (path, false),
        _ => (home.to_path_buf(), true),
    }
}

fn join_savepoint_summary_from_config(
    bundle_dir: &Path,
    config_path: &Path,
    home: &Path,
) -> Result<JoinSavepointSummary, String> {
    let config = load_config(config_path)?;
    let bundle_dir = absolute_path(bundle_dir.to_path_buf())?;
    let mut manifest: SavepointManifest = read_json(&bundle_dir.join("manifest.json"))?;
    if manifest.schema != SAVEPOINT_SCHEMA {
        return Err(format!("Unsupported savepoint schema: {}", manifest.schema));
    }
    manifest.identity()?;
    manifest.lifecycle = manifest.lifecycle.normalized();
    let handoff_path = bundle_dir.join("handoff.md");
    let handoff_metadata = fs::metadata(&handoff_path).map_err(|error| {
        format!(
            "Savepoint handoff is not ready at {}: {error}",
            handoff_path.display()
        )
    })?;
    if !handoff_metadata.is_file() || handoff_metadata.len() == 0 {
        return Err(format!(
            "Savepoint handoff is not ready at {}",
            handoff_path.display()
        ));
    }
    let (resolved_cwd, cwd_missing) =
        resolve_join_cwd(&manifest.cwd, config.dropbox_root.as_deref(), home);
    // These two strings leave the app: `handoff_path` is pasted into the join
    // prompt an agent must Read, and `resolved_cwd` becomes a shell cwd. Both
    // must be plain paths — see strip_extended_length_prefix.
    Ok(JoinSavepointSummary {
        resolved_cwd: strip_extended_length_prefix(&resolved_cwd.to_string_lossy()),
        handoff_path: strip_extended_length_prefix(&handoff_path.to_string_lossy()),
        cwd_missing,
        source_checkpoint_id: manifest.lifecycle.checkpoint_id,
    })
}

fn find_transcript(bundle_dir: &Path) -> Result<PathBuf, String> {
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

pub(crate) fn sanitize_project_dir(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn join_savepoint_full_from_config(
    bundle_dir: &Path,
    config_path: &Path,
    home: &Path,
    projects_dir: &Path,
) -> Result<JoinSavepointFull, String> {
    let config = load_config(config_path)?;
    let bundle_dir = absolute_path(bundle_dir.to_path_buf())?;
    let mut manifest: SavepointManifest = read_json(&bundle_dir.join("manifest.json"))?;
    if manifest.schema != SAVEPOINT_SCHEMA {
        return Err(format!("Unsupported savepoint schema: {}", manifest.schema));
    }
    let identity = manifest.identity()?;
    manifest.lifecycle = manifest.lifecycle.normalized();
    let (resolved_cwd, cwd_missing) =
        resolve_join_cwd(&manifest.cwd, config.dropbox_root.as_deref(), home);
    let resolved_cwd_string = resolved_cwd.to_string_lossy().into_owned();
    let transcript = find_transcript(&bundle_dir)?;
    let (resume_session_id, command_argv) = match identity.kind {
        SavepointAgentKind::Claude => {
            let project_dir = projects_dir.join(sanitize_project_dir(&resolved_cwd_string));
            fs::create_dir_all(&project_dir)
                .map_err(|error| format!("Failed to create {}: {error}", project_dir.display()))?;
            let resume_session_id = Uuid::new_v4().to_string();
            let target = project_dir.join(format!("{resume_session_id}.jsonl"));
            fs::copy(&transcript, &target).map_err(|error| {
                format!(
                    "Failed to copy {} to {}: {error}",
                    transcript.display(),
                    target.display()
                )
            })?;
            let command_argv = vec![
                "claude".to_string(),
                "--resume".to_string(),
                resume_session_id.clone(),
                "--fork-session".to_string(),
            ];
            (resume_session_id, command_argv)
        }
        SavepointAgentKind::Codex => {
            let resume_session_id = crate::agent_transcript::import_codex_transcript(
                &transcript,
                &home.join(".codex").join("sessions"),
                &identity.session_id,
                &resolved_cwd_string,
            )?;
            let command_argv = vec![
                "codex".to_string(),
                "fork".to_string(),
                "--no-alt-screen".to_string(),
                resume_session_id.clone(),
            ];
            (resume_session_id, command_argv)
        }
    };
    Ok(JoinSavepointFull {
        resolved_cwd: resolved_cwd_string,
        cwd_missing,
        resume_session_id: Some(resume_session_id.clone()),
        command_argv,
        agent_kind: identity.kind,
        source_checkpoint_id: manifest.lifecycle.checkpoint_id,
    })
}
