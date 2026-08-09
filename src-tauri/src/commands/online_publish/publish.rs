#[allow(clippy::too_many_arguments)]
fn publish_savepoint_impl(
    config_path: &Path,
    home: &Path,
    transcript_root: &Path,
    agent_kind: SavepointAgentKind,
    cwd: &str,
    agent_session_id: Option<&str>,
    summary: Option<&str>,
    next_step: Option<&str>,
    mode: PublishMode,
    now: chrono::DateTime<Utc>,
    progress: &mut dyn FnMut(PublishProgressPayload),
) -> Result<PublishSavepointResult, String> {
    let _publish_guard = PUBLISH_LOCK
        .lock()
        .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
    let config = load_config(config_path)?;
    let online_dir = super::online::local_savepoint_dir(&config, home)?;
    let author = config
        .author
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("USERNAME").ok())
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "user".to_string());
    let machine = config
        .machine
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(sysinfo::System::host_name)
        .unwrap_or_default();

    let (jsonl_path, session_id) =
        locate_agent_transcript(transcript_root, agent_kind, cwd, agent_session_id)?;
    let digest = digest_agent_transcript(agent_kind, &jsonl_path)?;
    progress(publish_progress(
        PublishProgressStage::Digest,
        agent_kind,
        &session_id,
    ));
    let mapper = PathMapper {
        dropbox_root: config.dropbox_root.clone(),
    };
    let summary_line = build_summary_line(summary, &digest);
    let (handoff_md, mut warnings) =
        build_handoff_md(&digest, &mapper, &summary_line, &author, next_step);
    if let Some(requested) = agent_session_id {
        if requested != session_id {
            warnings.insert(
                0,
                format!(
                    "タブ記録のセッション {} に会話ログが無いため、この作業ディレクトリの最新会話 {} を保存しました",
                    requested.chars().take(8).collect::<String>(),
                    session_id.chars().take(8).collect::<String>()
                ),
            );
        }
    }
    progress(publish_progress(
        PublishProgressStage::Handoff,
        agent_kind,
        &session_id,
    ));

    fs::create_dir_all(&online_dir)
        .map_err(|error| format!("Failed to create {}: {error}", online_dir.display()))?;
    let final_records_dir =
        safe_final_records_dir(&online_dir, matches!(mode, PublishMode::Final(_)))?;
    let author_slug: String = author
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    let author_slug = if author_slug.is_empty() {
        "user".to_string()
    } else {
        author_slug
    };
    let short_id: String = session_id.chars().take(8).collect();
    let head_dir = if agent_kind == SavepointAgentKind::Codex {
        online_dir.join(format!("{author_slug}_codex_{short_id}"))
    } else {
        online_dir.join(format!("{author_slug}_{short_id}"))
    };

    // Mutable head preserves its identity while active. Publishing again after
    // a finalized generation starts a new checkpoint linked to the previous one.
    let jst = FixedOffset::east_opt(9 * 3600).expect("JST offset");
    let now_jst = now.with_timezone(&jst);
    let now_text = now_jst.to_rfc3339_opts(SecondsFormat::Secs, false);
    let previous_manifest = read_head_manifest_with_recovery(&head_dir);
    let previous_lifecycle = lifecycle_from_manifest(previous_manifest.as_ref());
    let previous_final_exists = previous_lifecycle.checkpoint_id.as_ref().is_some_and(|id| {
        final_records_dir
            .as_ref()
            .is_some_and(|records_dir| records_dir.join(id).exists())
    });
    let previous_final_was_trashed = previous_manifest.as_ref().is_some_and(|manifest| {
        manifest
            .get(TRASHED_FINAL_CHECKPOINT_FIELD)
            .and_then(Value::as_str)
            == previous_lifecycle.checkpoint_id.as_deref()
    });
    let starts_new_generation = (mode == PublishMode::Current
        && (previous_lifecycle.status == SavepointLifecycleStatus::Closed
            || previous_final_exists))
        || (mode != PublishMode::Current && previous_final_was_trashed);
    let checkpoint_id = if starts_new_generation {
        uuid::Uuid::new_v4().to_string()
    } else {
        previous_lifecycle
            .checkpoint_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    };
    let parent_checkpoint_id = if starts_new_generation {
        previous_lifecycle.checkpoint_id.clone()
    } else {
        previous_lifecycle.parent_checkpoint_id.clone()
    };
    let created_at = if starts_new_generation {
        now_text.clone()
    } else {
        previous_manifest
            .as_ref()
            .and_then(|value| value.get("created_at"))
            .and_then(Value::as_str)
            .unwrap_or(&now_text)
            .to_string()
    };
    let pinned = previous_manifest
        .as_ref()
        .and_then(|value| value.get("pinned"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let record_kind = match mode {
        PublishMode::Current => SavepointRecordKind::Current,
        PublishMode::Final(_) => SavepointRecordKind::Final,
    };
    let target_dir = match mode {
        PublishMode::Current => head_dir.clone(),
        PublishMode::Final(_) => final_records_dir
            .as_ref()
            .expect("final records directory is created for final mode")
            .join(&checkpoint_id),
    };
    let mut updated = target_dir.join("manifest.json").is_file();
    if mode != PublishMode::Current && updated {
        let existing: Value = read_json(&target_dir.join("manifest.json"))?;
        let existing_lifecycle = validate_final_record(
            &existing,
            &target_dir,
            agent_kind,
            &session_id,
            &checkpoint_id,
        )?;
        let existing = write_head_from_final_record(&target_dir, &head_dir)?;
        progress(publish_progress(
            PublishProgressStage::Done,
            agent_kind,
            &session_id,
        ));
        return Ok(PublishSavepointResult {
            bundle_dir: target_dir.to_string_lossy().into_owned(),
            session_id,
            summary_line: existing
                .get("summary_line")
                .and_then(Value::as_str)
                .unwrap_or(&summary_line)
                .to_string(),
            files_written: existing
                .get("files_written")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            files_read: 0,
            warnings: existing
                .get("warnings")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            updated: true,
            record_kind,
            checkpoint_id,
            parent_checkpoint_id: existing_lifecycle.parent_checkpoint_id,
        });
    }
    let updated_at = now_jst.to_rfc3339_opts(SecondsFormat::Secs, false);
    let expires_at = (now_jst + ChronoDuration::hours(DEFAULT_EXPIRE_HOURS))
        .to_rfc3339_opts(SecondsFormat::Secs, false);

    let cwd_token = digest
        .cwd
        .as_deref()
        .map(|value| mapper.tokenize(value).0)
        .unwrap_or_else(|| norm_slashes(cwd));
    let tokenized = |paths: &[String]| -> Vec<String> {
        paths.iter().map(|path| mapper.tokenize(path).0).collect()
    };
    let mut files_touched = tokenized(&digest.files_written);
    files_touched.extend(tokenized(&digest.files_read));
    let closed_reason = match mode {
        PublishMode::Current => None,
        PublishMode::Final(reason) => Some(reason.as_str().to_string()),
    };
    let lifecycle = SavepointLifecycle {
        status: if record_kind == SavepointRecordKind::Final {
            SavepointLifecycleStatus::Closed
        } else {
            SavepointLifecycleStatus::Active
        },
        checkpoint_id: Some(checkpoint_id.clone()),
        parent_checkpoint_id: parent_checkpoint_id.clone(),
        final_checkpoint: record_kind == SavepointRecordKind::Final,
        closed_at: (record_kind == SavepointRecordKind::Final).then(|| updated_at.clone()),
        closed_reason: closed_reason.clone(),
    };
    let make_manifest = |lifecycle: SavepointLifecycle| {
        serde_json::json!({
            "schema": SAVEPOINT_SCHEMA,
            "author": author.clone(),
            "machine": machine.clone(),
            "created_at": created_at.clone(),
            "updated_at": updated_at.clone(),
            "expires_at": expires_at.clone(),
            "pinned": pinned,
            "summary_line": summary_line.clone(),
            "cwd": cwd_token.clone(),
            "agent_kind": agent_kind,
            "agent_session_id": session_id.clone(),
            "claude_session_id": (agent_kind == SavepointAgentKind::Claude)
                .then(|| session_id.clone()),
            "files_touched": files_touched.clone(),
            "files_written": tokenized(&digest.files_written),
            "git_branch": digest.git_branch.clone(),
            "warnings": warnings.clone(),
            "lifecycle": lifecycle,
        })
    };
    let manifest = make_manifest(lifecycle.clone());
    let make_tmp_dir = |target: &Path| -> Result<PathBuf, String> {
        let parent = target
            .parent()
            .ok_or_else(|| "Bundle parent directory not found".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        Ok(parent.join(format!(
            ".{}.tmp-{}",
            target
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        )))
    };
    if matches!(mode, PublishMode::Final(_))
        && (previous_lifecycle.checkpoint_id.is_none() || starts_new_generation)
    {
        // Persist the generated identity before creating the immutable record.
        // If the process stops between final creation and head closure, a retry
        // must resolve to the same checkpoint instead of creating a duplicate.
        let bootstrap_lifecycle = SavepointLifecycle {
            status: SavepointLifecycleStatus::Active,
            checkpoint_id: Some(checkpoint_id.clone()),
            parent_checkpoint_id: parent_checkpoint_id.clone(),
            final_checkpoint: false,
            closed_at: None,
            closed_reason: None,
        };
        let bootstrap_manifest = make_manifest(bootstrap_lifecycle);
        let bootstrap_tmp = make_tmp_dir(&head_dir)?;
        let bootstrap_outcome = (|| -> Result<(), String> {
            write_bundle_temp(
                &bootstrap_tmp,
                &bootstrap_manifest,
                &handoff_md,
                &jsonl_path,
            )?;
            atomic_swap_dir(&bootstrap_tmp, &head_dir)
        })();
        if bootstrap_tmp.exists() {
            let _ = fs::remove_dir_all(&bootstrap_tmp);
        }
        bootstrap_outcome?;
    }
    let tmp_dir = make_tmp_dir(&target_dir)?;
    let outcome = (|| -> Result<(), String> {
        write_bundle_temp(&tmp_dir, &manifest, &handoff_md, &jsonl_path)?;
        progress(publish_progress(
            PublishProgressStage::Bundle,
            agent_kind,
            &session_id,
        ));
        match mode {
            PublishMode::Current => {
                let finalized_during_save = safe_final_records_dir(&online_dir, false)?
                    .as_ref()
                    .is_some_and(|records_dir| records_dir.join(&checkpoint_id).exists());
                if finalized_during_save {
                    return Err(
                        "This checkpoint was finalized while saving. Please retry the current save."
                            .to_string(),
                    );
                }
                atomic_swap_dir(&tmp_dir, &target_dir)?;
            }
            PublishMode::Final(_) => {
                let created = atomic_create_dir(&tmp_dir, &target_dir)?;
                if !created {
                    updated = true;
                    let existing: Value = read_json(&target_dir.join("manifest.json"))?;
                    validate_final_record(
                        &existing,
                        &target_dir,
                        agent_kind,
                        &session_id,
                        &checkpoint_id,
                    )?;
                }
                write_head_from_final_record(&target_dir, &head_dir)?;
            }
        }
        progress(publish_progress(
            PublishProgressStage::Register,
            agent_kind,
            &session_id,
        ));
        Ok(())
    })();
    if tmp_dir.exists() {
        let _ = fs::remove_dir_all(&tmp_dir);
    }
    outcome?;
    progress(publish_progress(
        PublishProgressStage::Done,
        agent_kind,
        &session_id,
    ));

    Ok(PublishSavepointResult {
        bundle_dir: target_dir.to_string_lossy().into_owned(),
        session_id,
        summary_line,
        files_written: digest.files_written.len(),
        files_read: digest.files_read.len(),
        warnings,
        updated,
        record_kind,
        checkpoint_id,
        parent_checkpoint_id,
    })
}
