    use super::*;
    use std::time::Duration;

    fn write_jsonl(path: &std::path::Path, lines: &[serde_json::Value]) {
        let contents = lines
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(path, contents).unwrap();
    }

    fn write_no_cwd_jsonl(path: &std::path::Path) {
        write_jsonl(path, &[serde_json::json!({"type": "last-prompt"})]);
    }

    #[test]
    fn codex_process_emits_kind_before_session_id_is_detected() {
        let (agent_kind, agent_session_id, claude_session_id) =
            codex_agent_metadata_fields(None, None);
        let metadata = PtyMetadata {
            session_id: "pane-session".to_string(),
            cwd: r"C:\work".to_string(),
            git_branch: None,
            process_name: Some("codex".to_string()),
            agent_active: true,
            claude_session_id,
            agent_kind,
            agent_session_id,
        };

        assert_eq!(metadata.agent_kind.as_deref(), Some("codex"));
        assert!(metadata.agent_session_id.is_none());
    }

    fn write_claude_jsonl(path: &std::path::Path, cwd: &str) {
        write_jsonl(
            path,
            &[
                serde_json::json!({"type": "last-prompt"}),
                serde_json::json!({"type": "mode", "mode": "default"}),
                serde_json::json!({"type": "permission-mode", "permissionMode": "default"}),
                serde_json::json!({"type": "user", "cwd": cwd, "sessionId": "sid"}),
            ],
        );
    }

    fn wait_for_distinct_mtime() {
        std::thread::sleep(Duration::from_millis(25));
    }

    #[test]
    fn detect_claude_session_id_in_dir_uses_matching_cwd_not_newest() {
        let dir = tempfile::tempdir().unwrap();
        write_claude_jsonl(
            &dir.path().join("matching-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &dir.path().join("newer-other-cwd.jsonl"),
            r"C:\Users\miyaz\other",
        );

        assert_eq!(
            detect_claude_session_id_in_dir(
                dir.path(),
                r"C:/Users/miyaz/work",
                None,
                &HashSet::new(),
            )
            .as_deref(),
            Some("matching-session")
        );
    }

    #[test]
    fn detect_claude_codex_session_id_in_dir_falls_back_to_newest_when_no_cwd_is_readable() {
        let dir = tempfile::tempdir().unwrap();
        write_no_cwd_jsonl(&dir.path().join("older-session.jsonl"));
        wait_for_distinct_mtime();
        write_no_cwd_jsonl(&dir.path().join("newer-session.jsonl"));

        assert_eq!(
            detect_claude_codex_session_id_in_dir(
                dir.path(),
                r"C:\Users\miyaz\work",
                None,
                &HashSet::new(),
            )
            .as_deref(),
            Some("newer-session")
        );
    }

    #[test]
    fn detect_claude_session_id_in_dir_returns_none_when_readable_cwds_do_not_match() {
        let dir = tempfile::tempdir().unwrap();
        write_claude_jsonl(
            &dir.path().join("first-session.jsonl"),
            r"C:\Users\miyaz\one",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &dir.path().join("second-session.jsonl"),
            r"C:\Users\miyaz\two",
        );

        assert_eq!(
            detect_claude_session_id_in_dir(
                dir.path(),
                r"C:\Users\miyaz\three",
                None,
                &HashSet::new(),
            ),
            None
        );
    }

    #[test]
    fn detect_claude_session_id_in_dir_skips_claimed_newest_candidate() {
        let dir = tempfile::tempdir().unwrap();
        write_claude_jsonl(
            &dir.path().join("older-unclaimed.jsonl"),
            r"C:\Users\miyaz\work",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &dir.path().join("newer-claimed.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let excluded = HashSet::from(["newer-claimed".to_string()]);

        assert_eq!(
            detect_claude_session_id_in_dir(dir.path(), r"C:\Users\miyaz\work", None, &excluded,)
                .as_deref(),
            Some("older-unclaimed")
        );
    }

    #[test]
    fn claude_process_uses_claude_codex_mapping_authoritatively() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        write_claude_jsonl(
            &claude_dir.join("plain-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        write_claude_jsonl(
            &claude_codex_dir.join("codex-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let mappings = HashMap::from([(
            "pane-a".to_string(),
            AgentSessionMapping {
                agent_kind: Some("claude-codex".to_string()),
                session_id: "mapped-session".to_string(),
            },
        )]);
        let excluded = HashSet::new();
        let exact = Some("exact-session".to_string());
        let mapped = mapped_agent_session_attribution_for_pane(
            &mappings,
            "pane-a",
            DetectedAgentKind::Claude,
            &excluded,
            exact.as_deref(),
        );

        let attribution = select_claude_process_attribution(
            mapped,
            exact,
            None,
            None,
            None,
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &excluded,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude-codex",
                "mapped-session".to_string(),
            ))
        );
    }

    #[test]
    fn claude_process_falls_back_to_claude_codex_project_dir() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        write_claude_jsonl(
            &claude_codex_dir.join("codex-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let excluded = HashSet::from(["codex-dir-session".to_string()]);
        let detection_exclusions =
            detection_exclusions_for_exact_session(&excluded, Some("codex-dir-session"));

        let attribution = select_claude_process_attribution(
            None,
            Some("codex-dir-session".to_string()),
            None,
            None,
            None,
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &detection_exclusions,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude-codex",
                "codex-dir-session".to_string(),
            ))
        );
    }

    #[test]
    fn claude_process_preserves_previous_claude_codex_identity() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        let excluded = HashSet::new();

        let attribution = select_claude_process_attribution(
            None,
            None,
            None,
            Some("claude-codex"),
            Some("previous-codex-session".to_string()),
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &excluded,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude-codex",
                "previous-codex-session".to_string(),
            ))
        );
    }

    #[test]
    fn plain_claude_session_wins_when_both_project_dirs_match() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        write_claude_jsonl(
            &claude_dir.join("plain-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &claude_codex_dir.join("newer-codex-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let excluded = HashSet::new();

        let attribution = select_claude_process_attribution(
            None,
            None,
            None,
            None,
            None,
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &excluded,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude",
                "plain-dir-session".to_string(),
            ))
        );
    }

    #[test]
    fn plain_claude_exact_session_wins_over_stale_plain_mapping() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        write_claude_jsonl(
            &claude_dir.join("exact-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let mappings = HashMap::from([(
            "pane-a".to_string(),
            AgentSessionMapping {
                agent_kind: Some("claude".to_string()),
                session_id: "stale-mapped-session".to_string(),
            },
        )]);
        let excluded = HashSet::from(["exact-session".to_string()]);
        let exact = Some("exact-session".to_string());
        let detection_exclusions =
            detection_exclusions_for_exact_session(&excluded, exact.as_deref());
        let mapped = mapped_agent_session_attribution_for_pane(
            &mappings,
            "pane-a",
            DetectedAgentKind::Claude,
            &excluded,
            exact.as_deref(),
        );

        let attribution = select_claude_process_attribution(
            mapped,
            exact,
            None,
            None,
            None,
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &detection_exclusions,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude",
                "exact-session".to_string(),
            ))
        );
    }

    #[test]
    fn cached_agent_session_id_is_reserved_from_another_same_cwd_pane() {
        let dir = tempfile::tempdir().unwrap();
        write_claude_jsonl(
            &dir.path().join("older-pane-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &dir.path().join("newer-owner-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let mut cache = HashMap::from([(
            "owner-pane".to_string(),
            DetectedAgentCacheEntry {
                agent_pid: Pid::from_u32(101),
                agent_kind: DetectedAgentKind::Claude,
                session_id: "newer-owner-session".to_string(),
            },
        )]);
        let owners = reserve_cached_agent_session_ids(&mut cache, &HashSet::new());
        let excluded = agent_session_id_exclusions_for_pane(
            &HashSet::new(),
            &owners,
            &HashMap::new(),
            "second-pane",
        );

        assert_eq!(
            detect_claude_session_id_in_dir(dir.path(), r"C:\Users\miyaz\work", None, &excluded,)
                .as_deref(),
            Some("older-pane-session")
        );
    }

    #[test]
    fn cached_agent_session_id_remains_adoptable_by_its_owner() {
        let agent_pid = Pid::from_u32(101);
        let mut cache = HashMap::from([(
            "owner-pane".to_string(),
            DetectedAgentCacheEntry {
                agent_pid,
                agent_kind: DetectedAgentKind::Claude,
                session_id: "owner-session".to_string(),
            },
        )]);
        let owners = reserve_cached_agent_session_ids(&mut cache, &HashSet::new());
        let excluded = agent_session_id_exclusions_for_pane(
            &HashSet::new(),
            &owners,
            &HashMap::new(),
            "owner-pane",
        );
        let adopted = cached_detected_agent_session_id(
            &cache,
            "owner-pane",
            agent_pid,
            DetectedAgentKind::Claude,
        )
        .filter(|candidate| !excluded.contains(candidate));

        assert_eq!(adopted.as_deref(), Some("owner-session"));
    }

    #[test]
    fn pane_mapping_prevents_cross_pane_marker_overwrite_with_empty_cache() {
        let pane_a_session = "db723e1e-618b-4566-802c-c9486f7701b7";
        let pane_b_session = "b15c0d1c-e7ae-4d8a-beeb-39dbc5437dac";
        let mappings = HashMap::from([
            (
                "pane-a".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: pane_a_session.to_string(),
                },
            ),
            (
                "pane-b".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: pane_b_session.to_string(),
                },
            ),
        ]);
        let mapped_owners = mapped_agent_session_owners(&mappings);
        let excluded = agent_session_id_exclusions_for_pane(
            &HashSet::new(),
            &HashMap::new(),
            &mapped_owners,
            "pane-a",
        );

        let detected = preferred_known_agent_session_id(
            None,
            &mappings,
            &HashMap::new(),
            "pane-a",
            Pid::from_u32(101),
            DetectedAgentKind::Claude,
            &excluded,
        )
        // This is the same-CWD newest-file result that caused the live overwrite.
        .or_else(|| (!excluded.contains(pane_b_session)).then(|| pane_b_session.to_string()));

        assert!(excluded.contains(pane_b_session));
        assert!(!excluded.contains(pane_a_session));
        assert_eq!(detected.as_deref(), Some(pane_a_session));
        assert!(mapping_matches_agent_session(
            &mappings,
            "pane-a",
            "claude",
            pane_a_session,
        ));
        assert!(!mapping_matches_agent_session(
            &mappings,
            "pane-a",
            "claude",
            pane_b_session,
        ));
        assert!(!should_write_agent_session_mapping(
            &mappings,
            "pane-a",
            "claude",
            pane_a_session,
        ));
        assert!(should_write_agent_session_mapping(
            &mappings,
            "pane-a",
            "claude",
            pane_b_session,
        ));
    }

    #[test]
    fn duplicate_mapping_is_contested_until_one_owner_is_repaired() {
        let duplicate = "b15c0d1c-e7ae-4d8a-beeb-39dbc5437dac";
        let mappings = HashMap::from([
            (
                "pane-a".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: duplicate.to_string(),
                },
            ),
            (
                "pane-b".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: duplicate.to_string(),
                },
            ),
        ]);
        let mapped_owners = mapped_agent_session_owners(&mappings);

        for pane in ["pane-a", "pane-b"] {
            let excluded = agent_session_id_exclusions_for_pane(
                &HashSet::new(),
                &HashMap::new(),
                &mapped_owners,
                pane,
            );
            assert!(excluded.contains(duplicate));
            assert_eq!(
                mapped_agent_session_id_for_pane(
                    &mappings,
                    pane,
                    DetectedAgentKind::Claude,
                    &excluded,
                ),
                None
            );
        }
    }

    #[test]
    fn explicit_claim_supersedes_another_panes_cached_reservation() {
        let explicit_session = "explicit-session".to_string();
        let explicit_claims = HashSet::from([explicit_session.clone()]);
        let mut cache = HashMap::from([(
            "cached-pane".to_string(),
            DetectedAgentCacheEntry {
                agent_pid: Pid::from_u32(101),
                agent_kind: DetectedAgentKind::Claude,
                session_id: explicit_session.clone(),
            },
        )]);

        let owners = reserve_cached_agent_session_ids(&mut cache, &explicit_claims);
        let excluded = agent_session_id_exclusions_for_pane(
            &explicit_claims,
            &owners,
            &HashMap::new(),
            "cached-pane",
        );

        assert!(!cache.contains_key("cached-pane"));
        assert!(!owners.contains_key(&explicit_session));
        assert!(excluded.contains(&explicit_session));
    }

    #[test]
    fn session_id_from_args_ignores_resume_source_when_forking() {
        let source = "85d1dd8d-0f32-410e-91da-008f1cfb82a3";
        let args = vec![
            "claude".to_string(),
            "--resume".to_string(),
            source.to_string(),
            "--fork-session".to_string(),
        ];

        assert_eq!(session_id_from_args(&args, false), None);
    }

    #[test]
    fn session_id_from_args_keeps_exact_non_fork_ids() {
        let session = "401caf0d-c8d1-4c12-b0d4-ed291d41d356";
        let args = vec![
            "claude".to_string(),
            "--session-id".to_string(),
            session.to_string(),
        ];

        assert_eq!(session_id_from_args(&args, false).as_deref(), Some(session));
    }
