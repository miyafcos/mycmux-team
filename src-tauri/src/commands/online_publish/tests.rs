    use super::*;
    use chrono::TimeZone;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_transcript(path: &Path, cwd: &str) {
        let lines = [
            serde_json::json!({
                "type": "user",
                "cwd": cwd,
                "gitBranch": "master",
                "message": {"content": "最初の指示です"}
            }),
            serde_json::json!({
                "type": "user",
                "isMeta": true,
                "message": {"content": "meta noise"}
            }),
            serde_json::json!({
                "type": "user",
                "message": {"content": "<command-name>/skill</command-name>"}
            }),
            serde_json::json!({
                "type": "assistant",
                "message": {"content": [
                    {"type": "text", "text": "途中の応答"},
                    {"type": "tool_use", "name": "Read", "input": {"file_path": format!("{cwd}/notes.md")}},
                    {"type": "tool_use", "name": "Write", "input": {"file_path": format!("{cwd}/out.md")}},
                    {"type": "tool_use", "name": "Write", "input": {"file_path": format!("{cwd}/out.md")}},
                    {"type": "tool_use", "name": "Edit", "input": {"file_path": "C:/outside/tool.py"}}
                ]}
            }),
            serde_json::json!({
                "type": "user",
                "message": {"content": [{"type": "text", "text": "続きをお願いします"}]}
            }),
            serde_json::json!({
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "最後の応答の要旨です"}]}
            }),
        ];
        let body = lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(path, body).unwrap();
    }

    fn write_codex_transcript(path: &Path, session_id: &str, root_session_id: &str, cwd: &str) {
        let lines = [
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "session_id": root_session_id,
                    "cwd": cwd,
                    "git": {"branch": "main"}
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Codex user prompt"}]
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "Codex user prompt"}
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "apply_patch",
                    "input": "*** Begin Patch\n*** Update File: src/main.ts\n*** End Patch"
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "phase": "commentary",
                    "message": "Working on it"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Duplicated final"}]
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "phase": "final",
                    "message": "Codex final response"
                }
            }),
        ];
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            lines
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
    }

    struct PublishFixture {
        _temp: tempfile::TempDir,
        config_path: PathBuf,
        home: PathBuf,
        projects_dir: PathBuf,
        online_dir: PathBuf,
        cwd: String,
        session_id: String,
    }

    fn setup_fixture() -> PublishFixture {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let dropbox = temp.path().join("dropbox");
        let cwd_path = dropbox.join("project");
        let online_dir = dropbox.join("_mycmux_online");
        let projects_dir = temp.path().join("claude-projects");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&cwd_path).unwrap();
        fs::create_dir_all(&online_dir).unwrap();

        let cwd = cwd_path.to_string_lossy().into_owned();
        let session_id = "11112222-3333-4444-5555-666677778888".to_string();
        let project_dir = projects_dir.join(sanitize_project_dir(&cwd));
        fs::create_dir_all(&project_dir).unwrap();
        write_transcript(&project_dir.join(format!("{session_id}.jsonl")), &cwd);

        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({
                "local_dir": online_dir,
                "dropbox_root": dropbox,
                "author": "miyazaki",
                "machine": "home-windows"
            })
            .to_string(),
        )
        .unwrap();

        PublishFixture {
            _temp: temp,
            config_path,
            home,
            projects_dir,
            online_dir,
            cwd,
            session_id,
        }
    }

    fn publish_fixture(
        fixture: &PublishFixture,
        session: Option<&str>,
        summary: Option<&str>,
        now: chrono::DateTime<Utc>,
    ) -> PublishSavepointResult {
        let mut ignore_progress = |_payload: PublishProgressPayload| {};
        publish_savepoint_impl(
            &fixture.config_path,
            &fixture.home,
            &fixture.projects_dir,
            SavepointAgentKind::Claude,
            &fixture.cwd,
            session,
            summary,
            None,
            PublishMode::Current,
            now,
            &mut ignore_progress,
        )
        .unwrap()
    }

    fn finalize_fixture(
        fixture: &PublishFixture,
        now: chrono::DateTime<Utc>,
    ) -> PublishSavepointResult {
        let mut ignore_progress = |_payload: PublishProgressPayload| {};
        publish_savepoint_impl(
            &fixture.config_path,
            &fixture.home,
            &fixture.projects_dir,
            SavepointAgentKind::Claude,
            &fixture.cwd,
            Some(&fixture.session_id),
            None,
            None,
            PublishMode::Final(SavepointCloseReason::Manual),
            now,
            &mut ignore_progress,
        )
        .unwrap()
    }

    #[test]
    fn tokenize_is_case_insensitive_and_marks_outside_paths() {
        let mapper = PathMapper {
            dropbox_root: Some("C:\\Users\\Miyaz\\Dropbox".to_string()),
        };
        assert_eq!(
            mapper.tokenize("c:/users/miyaz/dropbox/案件/a.md"),
            ("{DROPBOX}/案件/a.md".to_string(), true)
        );
        assert_eq!(
            mapper.tokenize("C:/elsewhere/b.md"),
            ("C:/elsewhere/b.md".to_string(), false)
        );
    }

    #[test]
    fn utf8_slice_regression_tokenize_survives_lowercase_expansion() {
        // Lowercasing U+0130 expands its byte length. The old code applied the
        // original root byte length to the normalized path and sliced mid-char.
        let mapper = PathMapper {
            dropbox_root: Some("C:\\İ".to_string()),
        };
        assert_eq!(
            mapper.tokenize("c:/i\u{307}/案件/Report.md"),
            ("{DROPBOX}/案件/Report.md".to_string(), true)
        );
    }

    #[test]
    fn truncate_flattens_whitespace_and_appends_ellipsis() {
        assert_eq!(truncate("a  b\n\nc", 80), "a b c");
        let long = "あ".repeat(100);
        let truncated = truncate(&long, 80);
        assert_eq!(truncated.chars().count(), 80);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn publish_writes_bundle_with_manifest_handoff_and_transcript() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();

        let result = publish_fixture(&fixture, Some(&fixture.session_id), None, now);

        assert!(!result.updated);
        assert_eq!(result.session_id, fixture.session_id);
        assert_eq!(result.summary_line, "続きをお願いします");
        assert_eq!(result.files_written, 2);
        assert_eq!(result.files_read, 1);
        assert_eq!(result.warnings.len(), 1);

        let bundle_dir = fixture.online_dir.join("miyazaki_11112222");
        assert_eq!(result.bundle_dir, bundle_dir.to_string_lossy());
        let manifest: Value = read_json(&bundle_dir.join("manifest.json")).unwrap();
        assert_eq!(manifest["schema"], 1);
        assert_eq!(manifest["author"], "miyazaki");
        assert_eq!(manifest["machine"], "home-windows");
        assert_eq!(manifest["agent_kind"], "claude");
        assert_eq!(manifest["agent_session_id"], fixture.session_id.as_str());
        assert_eq!(manifest["claude_session_id"], fixture.session_id.as_str());
        assert_eq!(manifest["git_branch"], "master");
        assert_eq!(manifest["cwd"], "{DROPBOX}/project");
        assert_eq!(manifest["updated_at"], "2026-07-11T12:00:00+09:00");
        assert_eq!(manifest["expires_at"], "2026-07-13T12:00:00+09:00");
        assert_eq!(manifest["files_written"].as_array().unwrap().len(), 2);
        assert_eq!(manifest["files_touched"].as_array().unwrap().len(), 3);

        let handoff = fs::read_to_string(bundle_dir.join("handoff.md")).unwrap();
        assert!(handoff.contains("# 引き継ぎ: 続きをお願いします"));
        assert!(handoff.contains("最初の指示です"));
        assert!(handoff.contains("最後の応答の要旨です"));
        assert!(handoff.contains("`{DROPBOX}/project/out.md`"));
        assert!(handoff.contains("C:/outside/tool.py` ⚠Dropbox外"));
        assert!(bundle_dir
            .join("transcript")
            .join(format!("{}.jsonl", fixture.session_id))
            .is_file());
        assert!(!fs::read_dir(&fixture.online_dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"),));
    }

    #[test]
    fn utf8_slice_regression_publish_warning_truncates_non_ascii_session_ids() {
        // Session IDs arrive from the frontend. The old warning formatter
        // treated an eight-byte slice as eight characters and panicked.
        let mut fixture = setup_fixture();
        let project_dir = fixture
            .projects_dir
            .join(sanitize_project_dir(&fixture.cwd));
        let resolved = "実際会話セッション識別子";
        fs::rename(
            project_dir.join(format!("{}.jsonl", fixture.session_id)),
            project_dir.join(format!("{resolved}.jsonl")),
        )
        .unwrap();
        fixture.session_id = resolved.to_string();
        let requested = "要求記録セッション識別子";
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();

        let result = publish_fixture(&fixture, Some(requested), None, now);
        let requested_prefix: String = requested.chars().take(8).collect();
        let resolved_prefix: String = resolved.chars().take(8).collect();
        assert_eq!(
            result.warnings[0],
            format!(
                "タブ記録のセッション {requested_prefix} に会話ログが無いため、この作業ディレクトリの最新会話 {resolved_prefix} を保存しました"
            )
        );
    }

    #[test]
    fn publish_reports_all_progress_stages_for_the_resolved_session() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let mut progress = Vec::new();
        let mut collect_progress = |payload: PublishProgressPayload| progress.push(payload);

        publish_savepoint_impl(
            &fixture.config_path,
            &fixture.home,
            &fixture.projects_dir,
            SavepointAgentKind::Claude,
            &fixture.cwd,
            Some(&fixture.session_id),
            None,
            None,
            PublishMode::Current,
            now,
            &mut collect_progress,
        )
        .unwrap();

        assert_eq!(
            progress
                .iter()
                .map(|payload| payload.stage)
                .collect::<Vec<_>>(),
            vec![
                PublishProgressStage::Digest,
                PublishProgressStage::Handoff,
                PublishProgressStage::Bundle,
                PublishProgressStage::Register,
                PublishProgressStage::Done,
            ]
        );
        assert!(progress.iter().all(|payload| {
            payload.agent_kind == SavepointAgentKind::Claude
                && payload.agent_session_id == fixture.session_id
                && payload.claude_session_id.as_deref() == Some(fixture.session_id.as_str())
        }));
    }

    #[test]
    fn republish_upserts_preserving_created_at_and_pinned() {
        let fixture = setup_fixture();
        let first_now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let first = publish_fixture(&fixture, Some(&fixture.session_id), None, first_now);
        assert!(!first.updated);

        let bundle_dir = fixture.online_dir.join("miyazaki_11112222");
        let manifest_path = bundle_dir.join("manifest.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["pinned"] = Value::Bool(true);
        fs::write(&manifest_path, manifest.to_string()).unwrap();

        let second_now = Utc
            .with_ymd_and_hms(2026, 7, 11, 9, 30, 0)
            .single()
            .unwrap();
        let second = publish_fixture(
            &fixture,
            Some(&fixture.session_id),
            Some("上書きサマリ"),
            second_now,
        );

        assert!(second.updated);
        assert_eq!(second.summary_line, "上書きサマリ");
        let manifest: Value = read_json(&manifest_path).unwrap();
        assert_eq!(manifest["created_at"], "2026-07-11T12:00:00+09:00");
        assert_eq!(manifest["updated_at"], "2026-07-11T18:30:00+09:00");
        assert_eq!(manifest["pinned"], true);
        assert_eq!(manifest["summary_line"], "上書きサマリ");
        assert_eq!(manifest["lifecycle"]["status"], "active");
        assert_eq!(second.checkpoint_id, first.checkpoint_id);
    }

    #[test]
    fn finalize_creates_immutable_record_and_next_publish_starts_child_generation() {
        let fixture = setup_fixture();
        let first_now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let current = publish_fixture(&fixture, Some(&fixture.session_id), None, first_now);
        assert_eq!(current.record_kind, SavepointRecordKind::Current);

        let final_now = Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap();
        let finalized = finalize_fixture(&fixture, final_now);
        assert_eq!(finalized.record_kind, SavepointRecordKind::Final);
        assert_eq!(finalized.checkpoint_id, current.checkpoint_id);
        let record_dir = fixture
            .online_dir
            .join(FINAL_RECORDS_DIR)
            .join(&finalized.checkpoint_id);
        assert_eq!(record_dir.to_string_lossy(), finalized.bundle_dir);
        let final_manifest: Value = read_json(&record_dir.join("manifest.json")).unwrap();
        assert_eq!(final_manifest["lifecycle"]["status"], "closed");
        assert_eq!(final_manifest["lifecycle"]["final_checkpoint"], true);
        assert_eq!(final_manifest["lifecycle"]["closed_reason"], "manual");
        let original_record = fs::read(record_dir.join("manifest.json")).unwrap();

        // Simulate a stop after immutable creation but before head closure.
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let mut stranded_head: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        stranded_head["lifecycle"]["status"] = Value::String("active".to_string());
        stranded_head["lifecycle"]["final_checkpoint"] = Value::Bool(false);
        stranded_head["lifecycle"]["closed_at"] = Value::Null;
        stranded_head["lifecycle"]["closed_reason"] = Value::Null;
        fs::write(
            head_dir.join("manifest.json"),
            serde_json::to_string_pretty(&stranded_head).unwrap(),
        )
        .unwrap();

        fs::OpenOptions::new()
            .append(true)
            .open(
                fixture
                    .projects_dir
                    .join(sanitize_project_dir(&fixture.cwd))
                    .join(format!("{}.jsonl", fixture.session_id)),
            )
            .unwrap()
            .write_all(b"\n{\"type\":\"user\"}")
            .unwrap();
        let repeated = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );
        assert!(repeated.updated);
        assert_eq!(
            fs::read(record_dir.join("manifest.json")).unwrap(),
            original_record
        );
        let repaired_head: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        assert_eq!(repaired_head["lifecycle"]["status"], "closed");

        let resumed = publish_fixture(
            &fixture,
            Some(&fixture.session_id),
            Some("続きの現在地"),
            Utc.with_ymd_and_hms(2026, 7, 11, 6, 0, 0).single().unwrap(),
        );
        assert_ne!(resumed.checkpoint_id, finalized.checkpoint_id);
        assert_eq!(
            resumed.parent_checkpoint_id.as_deref(),
            Some(finalized.checkpoint_id.as_str())
        );
        let head_manifest: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        assert_eq!(head_manifest["lifecycle"]["status"], "active");
        assert_eq!(head_manifest["lifecycle"]["final_checkpoint"], false);
    }

    #[test]
    fn finalize_after_trashing_a_final_starts_a_new_checkpoint() {
        let fixture = setup_fixture();
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let record_dir = fixture
            .online_dir
            .join(FINAL_RECORDS_DIR)
            .join(&finalized.checkpoint_id);
        let trash_dir = fixture.online_dir.join("_trash").join("trash-fixture");
        fs::create_dir_all(trash_dir.parent().unwrap()).unwrap();
        fs::rename(&record_dir, &trash_dir).unwrap();
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let head_manifest_path = head_dir.join("manifest.json");
        let mut head_manifest: Value = read_json(&head_manifest_path).unwrap();
        head_manifest[TRASHED_FINAL_CHECKPOINT_FIELD] =
            Value::String(finalized.checkpoint_id.clone());
        fs::write(
            &head_manifest_path,
            serde_json::to_string_pretty(&head_manifest).unwrap(),
        )
        .unwrap();

        let repeated = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );

        assert_ne!(repeated.checkpoint_id, finalized.checkpoint_id);
        assert_eq!(
            repeated.parent_checkpoint_id.as_deref(),
            Some(finalized.checkpoint_id.as_str())
        );
        assert!(trash_dir.is_dir());
        assert!(fixture
            .online_dir
            .join(FINAL_RECORDS_DIR)
            .join(&repeated.checkpoint_id)
            .is_dir());
        let repaired_head: Value = read_json(&head_manifest_path).unwrap();
        assert_eq!(
            repaired_head["lifecycle"]["checkpoint_id"],
            repeated.checkpoint_id
        );
        assert_eq!(
            repaired_head["lifecycle"]["parent_checkpoint_id"],
            finalized.checkpoint_id
        );
        assert!(repaired_head.get(TRASHED_FINAL_CHECKPOINT_FIELD).is_none());
    }

    #[test]
    fn trashed_final_retry_reuses_bootstrapped_checkpoint() {
        let fixture = setup_fixture();
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let records_dir = fixture.online_dir.join(FINAL_RECORDS_DIR);
        let record_dir = records_dir.join(&finalized.checkpoint_id);
        let trash_dir = fixture.online_dir.join("_trash").join("trash-fixture");
        fs::create_dir_all(trash_dir.parent().unwrap()).unwrap();
        fs::rename(&record_dir, &trash_dir).unwrap();
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let head_manifest_path = head_dir.join("manifest.json");
        let mut head_manifest: Value = read_json(&head_manifest_path).unwrap();
        head_manifest[TRASHED_FINAL_CHECKPOINT_FIELD] =
            Value::String(finalized.checkpoint_id.clone());
        fs::write(
            &head_manifest_path,
            serde_json::to_string_pretty(&head_manifest).unwrap(),
        )
        .unwrap();

        let mut injected_target = None;
        let failure = {
            let mut inject_failure = |payload: PublishProgressPayload| {
                if payload.stage != PublishProgressStage::Bundle || injected_target.is_some() {
                    return;
                }
                let bootstrap: Value = read_json(&head_manifest_path).unwrap();
                let checkpoint_id = bootstrap["lifecycle"]["checkpoint_id"]
                    .as_str()
                    .unwrap()
                    .to_string();
                assert_ne!(checkpoint_id, finalized.checkpoint_id);
                assert_eq!(
                    bootstrap["lifecycle"]["parent_checkpoint_id"],
                    finalized.checkpoint_id
                );
                let target = records_dir.join(checkpoint_id);
                fs::create_dir_all(&target).unwrap();
                injected_target = Some(target);
            };
            publish_savepoint_impl(
                &fixture.config_path,
                &fixture.home,
                &fixture.projects_dir,
                SavepointAgentKind::Claude,
                &fixture.cwd,
                Some(&fixture.session_id),
                None,
                None,
                PublishMode::Final(SavepointCloseReason::Manual),
                Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
                &mut inject_failure,
            )
            .unwrap_err()
        };
        assert!(failure.contains("manifest.json"));
        let injected_target = injected_target.unwrap();
        let bootstrapped: Value = read_json(&head_manifest_path).unwrap();
        let bootstrapped_id = bootstrapped["lifecycle"]["checkpoint_id"]
            .as_str()
            .unwrap()
            .to_string();
        fs::rename(&injected_target, records_dir.join(".injected-conflict")).unwrap();

        let repeated = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 6, 0, 0).single().unwrap(),
        );

        assert_eq!(repeated.checkpoint_id, bootstrapped_id);
        assert_eq!(
            repeated.parent_checkpoint_id.as_deref(),
            Some(finalized.checkpoint_id.as_str())
        );
        let records = fs::read_dir(&records_dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry.path().is_dir() && !entry.file_name().to_string_lossy().starts_with('.')
            })
            .count();
        assert_eq!(records, 1);
    }

    #[test]
    fn invalid_checkpoint_id_cannot_escape_final_records_directory() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        publish_fixture(&fixture, Some(&fixture.session_id), None, now);
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let manifest_path = head_dir.join("manifest.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["lifecycle"]["checkpoint_id"] = Value::String("../../escaped".to_string());
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );

        assert!(uuid::Uuid::parse_str(&finalized.checkpoint_id).is_ok());
        let records_dir = fixture.online_dir.join(FINAL_RECORDS_DIR);
        assert_eq!(
            Path::new(&finalized.bundle_dir).parent(),
            Some(records_dir.as_path())
        );
        assert!(!fixture
            .online_dir
            .parent()
            .unwrap()
            .join("escaped")
            .exists());
    }

    #[test]
    fn old_final_record_does_not_rewind_a_newer_head() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        publish_fixture(&fixture, Some(&fixture.session_id), None, now);
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let old_record = fixture
            .online_dir
            .join(FINAL_RECORDS_DIR)
            .join(finalized.checkpoint_id);
        publish_fixture(
            &fixture,
            Some(&fixture.session_id),
            Some("new generation"),
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );
        let newer_head = fs::read(head_dir.join("manifest.json")).unwrap();

        write_head_from_final_record(&old_record, &head_dir).unwrap();

        assert_eq!(
            fs::read(head_dir.join("manifest.json")).unwrap(),
            newer_head
        );
    }

    #[test]
    fn current_publish_rotates_when_final_exists_but_head_is_still_active() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let current = publish_fixture(&fixture, Some(&fixture.session_id), None, now);
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let mut stranded_head: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        stranded_head["lifecycle"]["status"] = Value::String("active".to_string());
        stranded_head["lifecycle"]["final_checkpoint"] = Value::Bool(false);
        fs::write(
            head_dir.join("manifest.json"),
            serde_json::to_string_pretty(&stranded_head).unwrap(),
        )
        .unwrap();

        let resumed = publish_fixture(
            &fixture,
            Some(&fixture.session_id),
            Some("continued after stranded final"),
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );

        assert_eq!(current.checkpoint_id, finalized.checkpoint_id);
        assert_ne!(resumed.checkpoint_id, finalized.checkpoint_id);
        assert_eq!(
            resumed.parent_checkpoint_id.as_deref(),
            Some(finalized.checkpoint_id.as_str())
        );
    }

    #[test]
    fn finalize_recovers_checkpoint_id_from_interrupted_head_swap() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let current = publish_fixture(&fixture, Some(&fixture.session_id), None, now);
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        fs::rename(
            &head_dir,
            fixture.online_dir.join("miyazaki_11112222.old-crash"),
        )
        .unwrap();

        let repeated = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );

        assert_eq!(repeated.checkpoint_id, current.checkpoint_id);
        assert_eq!(repeated.checkpoint_id, finalized.checkpoint_id);
        let records = fs::read_dir(fixture.online_dir.join(FINAL_RECORDS_DIR))
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry.path().is_dir() && !entry.file_name().to_string_lossy().starts_with('.')
            })
            .count();
        assert_eq!(records, 1);
        let repaired: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        assert_eq!(repaired["lifecycle"]["status"], "closed");
    }

    #[test]
    fn final_records_path_must_be_a_real_directory() {
        let fixture = setup_fixture();
        fs::write(
            fixture.online_dir.join(FINAL_RECORDS_DIR),
            "not a directory",
        )
        .unwrap();

        assert!(safe_final_records_dir(&fixture.online_dir, true).is_err());
    }

    #[test]
    fn latest_session_fallback_picks_newest_jsonl() {
        let fixture = setup_fixture();
        let project_dir = fixture
            .projects_dir
            .join(sanitize_project_dir(&fixture.cwd));
        let older = project_dir.join("00000000-0000-4000-8000-000000000000.jsonl");
        write_transcript(&older, &fixture.cwd);
        let newest = project_dir.join(format!("{}.jsonl", fixture.session_id));
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(120);
        let file = fs::OpenOptions::new().append(true).open(&newest).unwrap();
        file.set_modified(future).unwrap();

        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let result = publish_fixture(&fixture, None, None, now);
        assert_eq!(result.session_id, fixture.session_id);
    }

    #[test]
    fn explicit_session_falls_back_to_cross_project_search() {
        let fixture = setup_fixture();
        let stray_dir = fixture.projects_dir.join("some-other-project");
        fs::create_dir_all(&stray_dir).unwrap();
        let stray_session = "99990000-aaaa-4bbb-8ccc-ddddeeeeffff";
        write_transcript(
            &stray_dir.join(format!("{stray_session}.jsonl")),
            &fixture.cwd,
        );

        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let result = publish_fixture(&fixture, Some(stray_session), None, now);
        assert_eq!(result.session_id, stray_session);
    }

    #[test]
    fn codex_digest_prefers_event_messages_and_collects_explicit_patch_paths() {
        let temp = tempdir().unwrap();
        let session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let path = temp
            .path()
            .join(format!("rollout-2026-07-14T10-00-00-{session_id}.jsonl"));
        write_codex_transcript(&path, session_id, session_id, "C:/work/codex");

        let digest = digest_codex_transcript(&path).unwrap();

        assert_eq!(digest.cwd.as_deref(), Some("C:/work/codex"));
        assert_eq!(digest.git_branch.as_deref(), Some("main"));
        assert_eq!(digest.user_prompts, vec!["Codex user prompt"]);
        assert_eq!(digest.turn_count, 1);
        assert_eq!(digest.last_assistant_text, "Codex final response");
        assert_eq!(digest.files_written, vec!["src/main.ts"]);
    }

    #[test]
    fn codex_locator_matches_payload_id_not_parent_session_id() {
        let temp = tempdir().unwrap();
        let requested = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let child = "11111111-2222-4333-8444-555555555555";
        let wrong = temp
            .path()
            .join("2026/07/13")
            .join(format!("rollout-2026-07-13T10-00-00-{requested}.jsonl"));
        write_codex_transcript(&wrong, child, requested, "C:/work/codex");
        let correct = temp
            .path()
            .join("2026/07/14")
            .join(format!("rollout-2026-07-14T10-00-00-{requested}.jsonl"));
        write_codex_transcript(&correct, requested, requested, "C:/work/codex");

        let (located, id) =
            locate_codex_transcript(temp.path(), "C:/work/codex", Some(requested)).unwrap();
        assert_eq!(located, correct);
        assert_eq!(id, requested);
    }

    #[test]
    fn codex_locator_never_falls_back_when_explicit_id_is_missing() {
        let temp = tempdir().unwrap();
        let existing = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let missing = "99999999-8888-4777-8666-555555555555";
        let path = temp
            .path()
            .join("2026/07/14")
            .join(format!("rollout-2026-07-14T10-00-00-{existing}.jsonl"));
        write_codex_transcript(&path, existing, existing, "C:/work/codex");

        let error =
            locate_codex_transcript(temp.path(), "C:/work/codex", Some(missing)).unwrap_err();
        assert!(error.contains(missing));
    }

    #[test]
    fn codex_publish_writes_generic_manifest_without_legacy_claude_identity() {
        let fixture = setup_fixture();
        let session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let sessions_root = fixture._temp.path().join("codex-sessions");
        let transcript = sessions_root
            .join("2026/07/14")
            .join(format!("rollout-2026-07-14T10-00-00-{session_id}.jsonl"));
        write_codex_transcript(&transcript, session_id, session_id, &fixture.cwd);
        let mut progress = Vec::new();

        let result = publish_savepoint_impl(
            &fixture.config_path,
            &fixture.home,
            &sessions_root,
            SavepointAgentKind::Codex,
            &fixture.cwd,
            Some(session_id),
            None,
            None,
            PublishMode::Current,
            Utc.with_ymd_and_hms(2026, 7, 14, 1, 0, 0).single().unwrap(),
            &mut |payload| progress.push(payload),
        )
        .unwrap();

        let bundle = fixture.online_dir.join("miyazaki_codex_aaaaaaaa");
        assert_eq!(result.bundle_dir, bundle.to_string_lossy());
        let manifest: Value = read_json(&bundle.join("manifest.json")).unwrap();
        assert_eq!(manifest["agent_kind"], "codex");
        assert_eq!(manifest["agent_session_id"], session_id);
        assert!(manifest["claude_session_id"].is_null());
        assert!(progress.iter().all(|payload| {
            payload.agent_kind == SavepointAgentKind::Codex
                && payload.agent_session_id == session_id
                && payload.claude_session_id.is_none()
        }));
    }
