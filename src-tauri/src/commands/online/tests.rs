    use super::*;
    use tempfile::tempdir;

    #[cfg(windows)]
    #[test]
    fn reparse_filter_allows_cloud_placeholders_but_rejects_links() {
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

        assert!(is_redirecting_windows_reparse_point(
            FILE_ATTRIBUTE_REPARSE_POINT,
            true,
        ));
        assert!(!is_redirecting_windows_reparse_point(
            FILE_ATTRIBUTE_REPARSE_POINT,
            false,
        ));
        assert!(!is_redirecting_windows_reparse_point(0, true));
    }

    #[cfg(windows)]
    #[test]
    fn display_path_preserves_unc_roots() {
        assert_eq!(
            path_for_display(Path::new(r"\\?\UNC\server\share\savepoints")),
            r"\\server\share\savepoints"
        );
    }

    #[test]
    fn storage_settings_use_the_local_default_without_a_config() {
        let temp = tempdir().unwrap();
        let settings = get_savepoint_storage_settings_from_config(
            &temp.path().join("missing.json"),
            temp.path(),
        )
        .unwrap();

        assert_eq!(
            settings,
            SavepointStorageSettings {
                directory: Some(path_for_display(
                    &temp.path().join(".mycmux").join("savepoints"),
                )),
                directory_exists: false,
                legacy_directory: None,
            }
        );
    }

    #[test]
    fn legacy_shared_directory_is_displayed_but_not_used_as_the_local_store() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let shared = temp.path().join("shared-savepoints");
        fs::create_dir_all(home.join(".mycmux")).unwrap();
        fs::create_dir_all(&shared).unwrap();
        let config_path = home.join(".mycmux").join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "online_dir": shared }).to_string(),
        )
        .unwrap();

        let settings = get_savepoint_storage_settings_from_config(&config_path, &home).unwrap();

        assert_eq!(
            settings.directory,
            Some(path_for_display(&home.join(".mycmux").join("savepoints")))
        );
        assert_eq!(
            settings.legacy_directory,
            Some(path_for_display(&shared))
        );
    }

    #[test]
    fn legacy_directory_inside_mycmux_is_reused_without_migration() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let existing = home.join(".mycmux").join("online-dev");
        fs::create_dir_all(&existing).unwrap();
        let config = SavepointConfig {
            online_dir: Some(existing.to_string_lossy().into_owned()),
            ..SavepointConfig::default()
        };

        assert_eq!(
            local_savepoint_dir(&config, &home).unwrap(),
            fs::canonicalize(existing).unwrap()
        );
    }

    #[test]
    fn invalid_legacy_directory_falls_back_without_blocking_local_savepoints() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(home.join(".mycmux")).unwrap();
        let config = SavepointConfig {
            online_dir: Some("../shared-savepoints".to_string()),
            ..SavepointConfig::default()
        };

        assert_eq!(
            local_savepoint_dir(&config, &home).unwrap(),
            home.join(".mycmux").join("savepoints")
        );
    }

    #[test]
    fn profile_rejects_an_absolute_local_dir_outside_its_runtime() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let config = SavepointConfig {
            local_dir: Some(home.join(".mycmux").join("savepoints").to_string_lossy().into_owned()),
            ..SavepointConfig::default()
        };

        let profile_runtime = home.join(".mycmux-profile");
        let error = local_savepoint_dir_for_profile(&config, &home, Some(&profile_runtime))
            .expect_err("profile must not reach the production savepoint tree");

        assert!(error.contains("must stay inside its runtime directory"));
    }

    #[test]
    fn profile_accepts_an_absolute_local_dir_inside_its_runtime() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let runtime = home.join(".mycmux-profile");
        let local_dir = runtime.join("savepoints").join("isolated");
        let config = SavepointConfig {
            local_dir: Some(local_dir.to_string_lossy().into_owned()),
            ..SavepointConfig::default()
        };

        assert_eq!(
            local_savepoint_dir_for_profile(&config, &home, Some(&runtime)).unwrap(),
            local_dir
        );
    }

    fn fixture_online_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("commands")
            .join("fixtures")
            .join("online_savepoint")
    }

    fn copy_fixture_bundle(target: &Path) {
        let source = fixture_online_dir().join("miyazaki_85d1dd8d");
        fs::create_dir_all(target.join("transcript")).unwrap();
        fs::copy(source.join("manifest.json"), target.join("manifest.json")).unwrap();
        fs::copy(source.join("handoff.md"), target.join("handoff.md")).unwrap();
        fs::copy(
            source
                .join("transcript")
                .join("85d1dd8d-0f32-410e-91da-008f1cfb82a3.jsonl"),
            target
                .join("transcript")
                .join("85d1dd8d-0f32-410e-91da-008f1cfb82a3.jsonl"),
        )
        .unwrap();
    }

    fn write_cleanup_bundle(
        online_dir: &Path,
        name: &str,
        machine: &str,
        pinned: bool,
        expires_at: &str,
    ) {
        let bundle = online_dir.join(name);
        fs::create_dir_all(&bundle).unwrap();
        fs::write(
            bundle.join("manifest.json"),
            serde_json::json!({
                "schema": 1,
                "author": "miyazaki",
                "machine": machine,
                "created_at": "2026-07-01T00:00:00Z",
                "updated_at": "2026-07-01T00:00:00Z",
                "pinned": pinned,
                "expires_at": expires_at,
                "summary_line": "cleanup fixture",
                "cwd": "C:/work",
                "claude_session_id": "11111111-2222-4333-8444-555555555555"
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn lists_bundle_from_manifest_fixture() {
        let temp = tempdir().unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": fixture_online_dir() }).to_string(),
        )
        .unwrap();

        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.author, "miyazaki");
        assert_eq!(entry.machine, "home-windows");
        assert_eq!(entry.warnings_count, 2);
        assert_eq!(entry.files_written_count, 2);
        assert_eq!(entry.record_kind, SavepointRecordKind::Current);
        assert_eq!(
            entry.lifecycle_status,
            SavepointLifecycleStatus::Interrupted
        );
        assert!(entry.bundle_dir.ends_with("miyazaki_85d1dd8d"));
        assert!(entry.handoff_path.ends_with("handoff.md"));
    }

    #[test]
    fn lists_generic_codex_manifest_and_keeps_legacy_claude_compatibility() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let claude_bundle = online_dir.join("legacy-claude");
        let codex_bundle = online_dir.join("generic-codex");
        copy_fixture_bundle(&claude_bundle);
        copy_fixture_bundle(&codex_bundle);
        let manifest_path = codex_bundle.join("manifest.json");
        let mut codex: serde_json::Value = read_json(&manifest_path).unwrap();
        codex.as_object_mut().unwrap().remove("claude_session_id");
        codex["agent_kind"] = serde_json::Value::String("codex".to_string());
        codex["agent_session_id"] =
            serde_json::Value::String("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".to_string());
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&codex).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": online_dir }).to_string(),
        )
        .unwrap();

        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();

        assert_eq!(entries.len(), 2);
        let claude = entries
            .iter()
            .find(|entry| entry.bundle_dir.ends_with("legacy-claude"))
            .unwrap();
        assert_eq!(claude.agent_kind, SavepointAgentKind::Claude);
        assert_eq!(
            claude.claude_session_id.as_deref(),
            Some(claude.agent_session_id.as_str())
        );
        let codex = entries
            .iter()
            .find(|entry| entry.bundle_dir.ends_with("generic-codex"))
            .unwrap();
        assert_eq!(codex.agent_kind, SavepointAgentKind::Codex);
        assert_eq!(
            codex.agent_session_id,
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        );
        assert!(codex.claude_session_id.is_none());
    }

    #[test]
    fn invalid_lifecycle_defaults_without_rejecting_manifest() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("miyazaki_85d1dd8d");
        copy_fixture_bundle(&bundle);
        let manifest_path = bundle.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        manifest["lifecycle"] = serde_json::json!({
            "status": "future-status",
            "checkpoint_id": "11111111-2222-4333-8444-555555555555"
        });
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": online_dir }).to_string(),
        )
        .unwrap();

        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].lifecycle_status,
            SavepointLifecycleStatus::Interrupted
        );
        assert_eq!(entries[0].checkpoint_id, None);
    }

    #[test]
    fn list_prefers_immutable_final_record_over_closed_head() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let head = online_dir.join("miyazaki_85d1dd8d");
        let checkpoint_id = "11111111-2222-4333-8444-555555555555";
        copy_fixture_bundle(&head);
        let mut head_manifest: serde_json::Value = read_json(&head.join("manifest.json")).unwrap();
        head_manifest["lifecycle"] = serde_json::json!({
            "status": "closed",
            "checkpoint_id": checkpoint_id,
            "parent_checkpoint_id": null,
            "final_checkpoint": false,
            "closed_at": "2026-07-13T10:00:00+09:00",
            "closed_reason": "manual"
        });
        fs::write(
            head.join("manifest.json"),
            serde_json::to_string_pretty(&head_manifest).unwrap(),
        )
        .unwrap();
        let final_record = online_dir.join(FINAL_RECORDS_DIR).join(checkpoint_id);
        copy_fixture_bundle(&final_record);
        let mut final_manifest: serde_json::Value =
            read_json(&final_record.join("manifest.json")).unwrap();
        final_manifest["lifecycle"] = serde_json::json!({
            "status": "closed",
            "checkpoint_id": checkpoint_id,
            "parent_checkpoint_id": null,
            "final_checkpoint": true,
            "closed_at": "2026-07-13T10:00:00+09:00",
            "closed_reason": "manual"
        });
        fs::write(
            final_record.join("manifest.json"),
            serde_json::to_string_pretty(&final_manifest).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": online_dir }).to_string(),
        )
        .unwrap();

        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].record_kind, SavepointRecordKind::Final);
        assert_eq!(entries[0].checkpoint_id.as_deref(), Some(checkpoint_id));
        assert!(entries[0].bundle_dir.contains(FINAL_RECORDS_DIR));

        fs::remove_dir_all(final_record).unwrap();
        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        assert!(entries.is_empty(), "closed compatibility heads stay hidden");
    }

    #[test]
    fn expands_dropbox_cwd_and_falls_back_to_home() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let dropbox = temp.path().join("dropbox");
        let project = dropbox.join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();

        let (resolved, missing) = resolve_join_cwd("{DROPBOX}/project", dropbox.to_str(), &home);
        assert_eq!(resolved, project);
        assert!(!missing);

        let (resolved, missing) = resolve_join_cwd("{DROPBOX}/missing", dropbox.to_str(), &home);
        assert_eq!(resolved, home);
        assert!(missing);

        let (resolved, missing) = resolve_join_cwd("C:/definitely/missing", None, &home);
        assert_eq!(resolved, home);
        assert!(missing);
    }

    #[test]
    fn summary_join_rejects_a_partially_synced_bundle_without_handoff() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let bundle = temp.path().join("online").join("partial-bundle");
        let config_path = temp.path().join("savepoint.json");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&bundle).unwrap();
        fs::copy(
            fixture_online_dir()
                .join("miyazaki_85d1dd8d")
                .join("manifest.json"),
            bundle.join("manifest.json"),
        )
        .unwrap();
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": bundle.parent().unwrap() }).to_string(),
        )
        .unwrap();

        let error = join_savepoint_summary_from_config(&bundle, &config_path, &home)
            .expect_err("a manifest without handoff.md must stay unavailable");

        assert!(error.contains("Savepoint handoff is not ready"));
    }

    #[test]
    fn summary_join_hands_out_paths_without_the_extended_length_prefix() {
        // fs::canonicalize returns `\\?\C:\...` on Windows. That form is what
        // reaches the join prompt an agent is told to Read, and Claude Code
        // denies Read on it (2026-08-06: silently, in "don't ask" mode). The
        // summary must hand out plain paths no matter how the caller spelled
        // the bundle directory.
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("dropbox").join("project-one");
        let bundle = temp.path().join("online").join("fixture-bundle");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        copy_fixture_bundle(&bundle);

        let manifest_path = bundle.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        manifest["cwd"] = serde_json::Value::String(project.to_string_lossy().into_owned());
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": bundle.parent().unwrap() }).to_string(),
        )
        .unwrap();

        let canonical_bundle = fs::canonicalize(&bundle).unwrap();
        let summary =
            join_savepoint_summary_from_config(&canonical_bundle, &config_path, &home).unwrap();

        assert!(
            !summary.handoff_path.starts_with(r"\\?\"),
            "handoff_path still carries the extended-length prefix: {}",
            summary.handoff_path
        );
        assert!(
            !summary.resolved_cwd.starts_with(r"\\?\"),
            "resolved_cwd still carries the extended-length prefix: {}",
            summary.resolved_cwd
        );
        assert!(summary.handoff_path.ends_with("handoff.md"));
        assert!(Path::new(&summary.handoff_path).is_file());
    }

    #[test]
    fn full_join_transplants_fixture_with_fresh_uuid() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("dropbox").join("project-one");
        let bundle = temp.path().join("online").join("fixture-bundle");
        let projects_dir = temp.path().join("claude-projects");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        copy_fixture_bundle(&bundle);

        let manifest_path = bundle.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        manifest["cwd"] = serde_json::Value::String(project.to_string_lossy().into_owned());
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": bundle.parent().unwrap() }).to_string(),
        )
        .unwrap();

        let first =
            join_savepoint_full_from_config(&bundle, &config_path, &home, &projects_dir).unwrap();
        let second =
            join_savepoint_full_from_config(&bundle, &config_path, &home, &projects_dir).unwrap();

        assert_eq!(first.resolved_cwd, project.to_string_lossy());
        assert!(!first.cwd_missing);
        assert_ne!(first.resume_session_id, second.resume_session_id);
        let first_session_id = first.resume_session_id.as_deref().unwrap();
        assert!(Uuid::parse_str(first_session_id).is_ok());
        assert_eq!(first_session_id.as_bytes()[14], b'4');
        assert_eq!(
            first.command_argv,
            vec!["claude", "--resume", first_session_id, "--fork-session"]
        );
        assert_eq!(first.agent_kind, SavepointAgentKind::Claude);
        let transplanted = projects_dir
            .join(sanitize_project_dir(&first.resolved_cwd))
            .join(format!("{first_session_id}.jsonl"));
        assert_eq!(
            fs::read_to_string(transplanted).unwrap(),
            fs::read_to_string(
                bundle
                    .join("transcript")
                    .join("85d1dd8d-0f32-410e-91da-008f1cfb82a3.jsonl")
            )
            .unwrap()
        );
    }

    #[test]
    fn codex_full_join_with_missing_cwd_uses_home_and_imports_a_fresh_session() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("missing-project");
        let bundle = temp.path().join("online").join("codex-bundle");
        let transcript_dir = bundle.join("transcript");
        let source_session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&transcript_dir).unwrap();
        fs::write(
            bundle.join("manifest.json"),
            serde_json::json!({
                "schema": 1,
                "author": "miyazaki",
                "machine": "home-windows",
                "created_at": "2026-07-14T10:00:00+09:00",
                "updated_at": "2026-07-14T10:00:00+09:00",
                "expires_at": "2026-07-16T10:00:00+09:00",
                "summary_line": "Codex checkpoint",
                "cwd": project,
                "agent_kind": "codex",
                "agent_session_id": source_session_id,
                "files_written": [],
                "warnings": []
            })
            .to_string(),
        )
        .unwrap();
        fs::write(bundle.join("handoff.md"), "# Codex checkpoint\n").unwrap();
        let source_tail = serde_json::json!({
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "continue"}
        })
        .to_string();
        let transcript = transcript_dir.join(format!(
            "rollout-2026-07-14T10-00-00-{source_session_id}.jsonl"
        ));
        fs::write(
            &transcript,
            format!(
                "{}\n{}",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": source_session_id,
                        "session_id": source_session_id,
                        "cwd": project
                    }
                }),
                source_tail
            ),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": bundle.parent().unwrap() }).to_string(),
        )
        .unwrap();

        let result = join_savepoint_full_from_config(
            &bundle,
            &config_path,
            &home,
            &temp.path().join("claude-projects"),
        )
        .unwrap();
        let imported_id = result.resume_session_id.as_deref().unwrap();

        assert_eq!(result.agent_kind, SavepointAgentKind::Codex);
        assert!(result.cwd_missing);
        assert_eq!(result.resolved_cwd, home.to_string_lossy());
        assert_ne!(imported_id, source_session_id);
        assert_eq!(
            result.command_argv,
            vec!["codex", "fork", "--no-alt-screen", imported_id]
        );
        let mut imported = Vec::new();
        let mut pending = vec![home.join(".codex").join("sessions")];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(&format!("-{imported_id}.jsonl")))
                {
                    imported.push(path);
                }
            }
        }
        assert_eq!(imported.len(), 1);
        let body = fs::read_to_string(&imported[0]).unwrap();
        let mut lines = body.lines();
        let meta: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(meta["payload"]["id"], imported_id);
        assert_eq!(meta["payload"]["session_id"], imported_id);
        assert_eq!(meta["payload"]["cwd"], home.to_string_lossy().as_ref());
        assert_eq!(lines.collect::<Vec<_>>().join("\n"), source_tail);
    }

    #[test]
    fn full_join_with_missing_cwd_transplants_into_the_home_fallback() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let bundle = temp.path().join("online").join("fixture-bundle");
        let projects_dir = temp.path().join("claude-projects");
        fs::create_dir_all(&home).unwrap();
        copy_fixture_bundle(&bundle);

        let manifest_path = bundle.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        manifest["cwd"] = serde_json::Value::String(
            temp.path()
                .join("missing-project")
                .to_string_lossy()
                .into_owned(),
        );
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": bundle.parent().unwrap() }).to_string(),
        )
        .unwrap();

        let result =
            join_savepoint_full_from_config(&bundle, &config_path, &home, &projects_dir).unwrap();

        assert!(result.cwd_missing);
        assert_eq!(result.resolved_cwd, home.to_string_lossy());
        let resume_session_id = result.resume_session_id.as_deref().unwrap();
        assert_eq!(
            result.command_argv,
            vec!["claude", "--resume", resume_session_id, "--fork-session"]
        );
        assert!(projects_dir
            .join(sanitize_project_dir(&home.to_string_lossy()))
            .join(format!("{resume_session_id}.jsonl"))
            .is_file());
    }

    #[test]
    fn pin_toggle_atomically_preserves_manifest_fields() {
        let temp = tempdir().unwrap();
        let bundle = temp.path().join("fixture-bundle");
        copy_fixture_bundle(&bundle);

        let toggled = toggle_savepoint_pin_at(&bundle).unwrap();
        assert!(toggled.pinned);
        let manifest: serde_json::Value = read_json(&bundle.join("manifest.json")).unwrap();
        assert_eq!(
            manifest.get("pinned").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            manifest
                .get("git_branch")
                .and_then(serde_json::Value::as_str),
            Some("master")
        );
        assert!(!fs::read_dir(&bundle)
            .unwrap()
            .flatten()
            .any(|entry| { entry.file_name().to_string_lossy().contains(".tmp-") }));

        let toggled = toggle_savepoint_pin_at(&bundle).unwrap();
        assert!(!toggled.pinned);
    }

    #[test]
    fn trash_move_preserves_bundle_and_lists_it_separately() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("bundle");
        copy_fixture_bundle(&bundle);
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": online_dir }).to_string(),
        )
        .unwrap();

        let trashed = trash_online_savepoint_at(
            &online_dir,
            &bundle,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();

        assert!(!bundle.exists());
        assert!(trashed.join("handoff.md").is_file());
        let active = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        let trash = list_trashed_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        assert!(active.is_empty());
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].deleted_at.as_deref(), Some("2026-07-14T12:00:00Z"));
        assert_eq!(trash[0].trash_reason, Some(SavepointTrashReason::Manual));
        copy_fixture_bundle(&bundle);
        let active = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        let trash = list_trashed_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        assert_eq!(
            active.len(),
            1,
            "a new save can reuse the original head path"
        );
        assert_eq!(trash.len(), 1, "the deleted snapshot stays in the trash");
    }

    #[test]
    fn trash_rejects_bundle_outside_online_dir() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&online_dir).unwrap();
        copy_fixture_bundle(&outside);

        assert!(trash_online_savepoint_at(
            &online_dir,
            &outside,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .is_err());
        assert!(outside.is_dir());
    }

    #[test]
    fn trash_rejects_bundle_without_manifest() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("bundle");
        fs::create_dir_all(&bundle).unwrap();

        assert!(trash_online_savepoint_at(
            &online_dir,
            &bundle,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .is_err());
        assert!(bundle.is_dir());
    }

    #[test]
    fn restore_refuses_to_overwrite_a_new_savepoint() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("bundle");
        copy_fixture_bundle(&bundle);
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &bundle,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let manifest: SavepointManifest = read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = manifest.trash.unwrap().id;
        copy_fixture_bundle(&bundle);

        assert!(restore_online_savepoint_at(&online_dir, &trashed, &trash_id).is_err());
        assert!(bundle.is_dir());
        assert!(trashed.is_dir());
    }

    #[test]
    fn restore_returns_bundle_to_its_original_location() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("bundle");
        copy_fixture_bundle(&bundle);
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &bundle,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let manifest: SavepointManifest = read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = manifest.trash.unwrap().id;

        let restored = restore_online_savepoint_at(&online_dir, &trashed, &trash_id).unwrap();

        assert_eq!(restored, fs::canonicalize(&bundle).unwrap());
        assert!(bundle.is_dir());
        let restored_manifest: serde_json::Value =
            read_json(&bundle.join("manifest.json")).unwrap();
        assert!(restored_manifest.get("trash").is_none());
        assert!(
            parse_iso_datetime(restored_manifest["expires_at"].as_str().unwrap())
                .is_some_and(|expires_at| expires_at > Utc::now())
        );
    }

    #[test]
    fn purge_removes_final_record_and_its_closed_shadow_only_from_trash() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let records_dir = online_dir.join(FINAL_RECORDS_DIR);
        let checkpoint_id = "11111111-2222-4333-8444-555555555555";
        let record = records_dir.join(checkpoint_id);
        let head = online_dir.join("author_11111111");
        copy_fixture_bundle(&record);
        copy_fixture_bundle(&head);
        for (path, final_checkpoint) in [(&record, true), (&head, false)] {
            let manifest_path = path.join("manifest.json");
            let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
            manifest["lifecycle"] = serde_json::json!({
                "status": "closed",
                "checkpoint_id": checkpoint_id,
                "final_checkpoint": final_checkpoint
            });
            fs::write(
                manifest_path,
                serde_json::to_string_pretty(&manifest).unwrap(),
            )
            .unwrap();
        }

        let toggled = toggle_savepoint_pin_at(&record).unwrap();
        assert!(toggled.pinned);
        let head_manifest: serde_json::Value = read_json(&head.join("manifest.json")).unwrap();
        assert_eq!(head_manifest["pinned"], true);

        let trashed = trash_online_savepoint_at(
            &online_dir,
            &record,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let trashed_manifest: SavepointManifest =
            read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = trashed_manifest.trash.unwrap().id;

        assert!(!record.exists());
        assert!(head.exists());
        let head_manifest: serde_json::Value = read_json(&head.join("manifest.json")).unwrap();
        assert_eq!(head_manifest[TRASHED_FINAL_CHECKPOINT_FIELD], checkpoint_id);

        restore_online_savepoint_at(&online_dir, &trashed, &trash_id).unwrap();
        let head_manifest: serde_json::Value = read_json(&head.join("manifest.json")).unwrap();
        assert!(head_manifest.get(TRASHED_FINAL_CHECKPOINT_FIELD).is_none());
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &record,
            "2026-07-14T13:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let trashed_manifest: SavepointManifest =
            read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = trashed_manifest.trash.unwrap().id;

        purge_online_savepoint_at(&online_dir, &trashed, &trash_id).unwrap();
        assert!(!trashed.exists());
        assert!(!head.exists());
        assert!(records_dir.is_dir());
        assert!(trash_online_savepoint_at(
            &online_dir,
            &records_dir,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .is_err());
    }

    #[test]
    fn purge_refuses_when_a_live_final_reappears() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let checkpoint_id = "11111111-2222-4333-8444-555555555555";
        let record = online_dir.join(FINAL_RECORDS_DIR).join(checkpoint_id);
        let head = online_dir.join("author_11111111");
        copy_fixture_bundle(&record);
        copy_fixture_bundle(&head);
        for (path, final_checkpoint) in [(&record, true), (&head, false)] {
            let manifest_path = path.join("manifest.json");
            let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
            manifest["lifecycle"] = serde_json::json!({
                "status": "closed",
                "checkpoint_id": checkpoint_id,
                "final_checkpoint": final_checkpoint
            });
            fs::write(
                manifest_path,
                serde_json::to_string_pretty(&manifest).unwrap(),
            )
            .unwrap();
        }
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &record,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let trashed_manifest: SavepointManifest =
            read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = trashed_manifest.trash.unwrap().id;

        copy_fixture_bundle(&record);
        let error = purge_online_savepoint_at(&online_dir, &trashed, &trash_id).unwrap_err();

        assert!(error.contains("A live final savepoint still exists"));
        assert!(record.is_dir());
        assert!(head.is_dir());
        assert!(trashed.is_dir());
    }

    #[test]
    fn purge_rejects_a_trashed_final_with_a_fully_spoofed_identity() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let records_dir = online_dir.join(FINAL_RECORDS_DIR);
        let original_checkpoint = "11111111-2222-4333-8444-555555555555";
        let victim_checkpoint = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let record = records_dir.join(original_checkpoint);
        let victim_head = online_dir.join("author_victim");
        copy_fixture_bundle(&record);
        copy_fixture_bundle(&victim_head);
        for (path, checkpoint_id, final_checkpoint, session_id) in [
            (&record, original_checkpoint, true, "original-session"),
            (&victim_head, victim_checkpoint, false, "victim-session"),
        ] {
            let manifest_path = path.join("manifest.json");
            let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
            manifest["claude_session_id"] = serde_json::Value::String(session_id.to_string());
            manifest["lifecycle"] = serde_json::json!({
                "status": "closed",
                "checkpoint_id": checkpoint_id,
                "final_checkpoint": final_checkpoint
            });
            fs::write(
                manifest_path,
                serde_json::to_string_pretty(&manifest).unwrap(),
            )
            .unwrap();
        }
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &record,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let manifest_path = trashed.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        let trash_id = manifest["trash"]["id"].as_str().unwrap().to_string();
        manifest["lifecycle"]["checkpoint_id"] =
            serde_json::Value::String(victim_checkpoint.to_string());
        manifest["claude_session_id"] = serde_json::Value::String("victim-session".to_string());
        manifest["trash"]["original_name"] =
            serde_json::Value::String(victim_checkpoint.to_string());
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        assert!(purge_online_savepoint_at(&online_dir, &trashed, &trash_id).is_err());
        assert!(victim_head.is_dir());
        assert!(trashed.is_dir());
    }

    #[test]
    fn cleanup_deletes_expired_and_stale_entries_from_the_local_store() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let online_dir = temp.path().join("online");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&online_dir).unwrap();
        write_cleanup_bundle(
            &online_dir,
            "expired",
            "machine-a",
            false,
            "2026-07-10T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            "pinned",
            "machine-a",
            true,
            "2026-07-10T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            "other",
            "machine-b",
            false,
            "2026-07-10T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            "future",
            "machine-a",
            false,
            "2026-07-13T00:00:00Z",
        );
        let records_dir = online_dir.join(FINAL_RECORDS_DIR);
        fs::create_dir_all(&records_dir).unwrap();
        write_cleanup_bundle(
            &records_dir,
            "final-expired",
            "machine-a",
            false,
            "2026-07-10T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            ".fixture.tmp-deadbeef",
            "machine-a",
            false,
            "2026-07-13T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            "fixture.old-1234-deadbeef",
            "machine-a",
            false,
            "2026-07-13T00:00:00Z",
        );
        fs::create_dir(online_dir.join(".git")).unwrap();
        fs::create_dir(online_dir.join("foo.old-copy")).unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({
                "local_dir": online_dir,
                "machine": "machine-a"
            })
            .to_string(),
        )
        .unwrap();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 0, 0, 0).single().unwrap();
        let future_system = SystemTime::now() + Duration::from_secs(STALE_TMP_SECONDS + 1);

        let result =
            cleanup_online_savepoints_from_config(&config_path, &home, now, future_system).unwrap();

        assert_eq!(result.deleted_count, 5);
        assert_eq!(result.expired_count, 3);
        assert_eq!(result.stale_count, 2);
        assert_eq!(result.kept_count, 4);
        assert!(!online_dir.join("expired").exists());
        assert!(!online_dir.join(".fixture.tmp-deadbeef").exists());
        assert!(!online_dir.join("fixture.old-1234-deadbeef").exists());
        assert!(!records_dir.join("final-expired").exists());
        let trashed = fs::read_dir(online_dir.join(TRASH_DIR))
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .count();
        assert_eq!(trashed, 3);
        assert!(online_dir.join(".git").is_dir());
        assert!(online_dir.join("foo.old-copy").is_dir());
        assert!(online_dir.join("pinned").is_dir());
        assert!(!online_dir.join("other").exists());
        assert!(online_dir.join("future").is_dir());
    }
