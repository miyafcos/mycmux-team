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
            process_status: Some("working".to_string()),
            process_status_at: None,
            last_output_at: Some(1_725_000_000_123),
            agent_active: true,
            claude_session_id,
            agent_kind,
            agent_session_id,
        };

        assert_eq!(metadata.agent_kind.as_deref(), Some("codex"));
        assert!(metadata.agent_session_id.is_none());
        assert_eq!(metadata.last_output_at, Some(1_725_000_000_123));
    }

    #[test]
    fn grok_mapping_matches_the_detected_grok_process() {
        let mapping = AgentSessionMapping {
            agent_kind: Some("grok".to_string()),
            session_id: "grok-session".to_string(),
        };
        assert!(mapping_matches_detected_agent_kind(&mapping, DetectedAgentKind::Grok));
    }

    #[test]
    fn process_status_timestamp_uses_the_stable_os_process_start_time() {
        let (status, status_at) =
            process_status_from_observation(Some("codex.exe"), Some(100));
        assert_eq!(status.as_deref(), Some("working"));
        assert_eq!(status_at, Some(100));

        let (idle_status, idle_at) =
            process_status_from_observation(Some("pwsh.exe"), Some(300));
        assert_eq!(idle_status.as_deref(), Some("idle"));
        assert_eq!(idle_at, Some(300));

        assert_eq!(process_status_from_observation(None, None), (None, None));
    }

    #[test]
    fn live_codex_and_shell_observations_both_produce_process_status() {
        for (process_name, expected_status) in
            [("codex.exe", "working"), ("pwsh.exe", "idle")]
        {
            let (status, status_at) =
                process_status_from_observation(Some(process_name), Some(500));
            assert_eq!(status.as_deref(), Some(expected_status));
            assert_eq!(status_at, Some(500));
        }
    }

    #[test]
    fn fresh_monitors_do_not_replace_process_start_times_with_poll_times() {
        for index in 0..33 {
            let process_started_at = 1_000 + index;
            let first = process_status_from_observation(
                Some("codex.exe"),
                Some(process_started_at),
            );
            let after_restart = process_status_from_observation(
                Some("codex.exe"),
                Some(process_started_at),
            );
            let (status, status_at) = first;
            assert_eq!(status.as_deref(), Some("working"));
            assert_eq!(status_at, Some(process_started_at));
            assert_eq!(after_restart.1, status_at);
        }
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

    /// Default for the cases that predate rollover handling: every transcript
    /// the pane is pinned to is still being written, so nothing may move.
    fn never_stale(_agent_kind: &str, _session_id: &str) -> bool {
        false
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
            never_stale,
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
            never_stale,
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
            never_stale,
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
            never_stale,
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
            never_stale,
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

    fn claude_family_dirs() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        (root, claude_dir, claude_codex_dir)
    }

    #[test]
    fn rollover_moves_the_pane_when_the_pinned_transcript_stopped_growing() {
        // The live defect: the pane was launched with `--session-id <pinned>`,
        // the CLI rolled over to a new id mid-run, and both the mapping file and
        // argv kept pointing at the transcript that stopped being written.
        let (_root, claude_dir, claude_codex_dir) = claude_family_dirs();
        write_claude_jsonl(&claude_dir.join("pinned-session.jsonl"), r"C:\Users\miyaz\work");
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &claude_dir.join("successor-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let mappings = HashMap::from([(
            "pane-a".to_string(),
            AgentSessionMapping {
                agent_kind: Some("claude".to_string()),
                session_id: "pinned-session".to_string(),
            },
        )]);
        let excluded = HashSet::new();
        let exact = Some("pinned-session".to_string());
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
            |_kind, session_id| session_id == "pinned-session",
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
                "successor-session".to_string(),
            ))
        );
    }

    #[test]
    fn a_live_pinned_transcript_is_never_re_detected() {
        // Negative case for the rollover path: while the mapped transcript is
        // still being written the pane must keep its id and the successor scan
        // must not even run.
        let (_root, claude_dir, claude_codex_dir) = claude_family_dirs();
        write_claude_jsonl(&claude_dir.join("pinned-session.jsonl"), r"C:\Users\miyaz\work");
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &claude_dir.join("newer-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let mappings = HashMap::from([(
            "pane-a".to_string(),
            AgentSessionMapping {
                agent_kind: Some("claude".to_string()),
                session_id: "pinned-session".to_string(),
            },
        )]);
        let excluded = HashSet::new();
        let exact = Some("pinned-session".to_string());
        let mapped = mapped_agent_session_attribution_for_pane(
            &mappings,
            "pane-a",
            DetectedAgentKind::Claude,
            &excluded,
            exact.as_deref(),
        );
        let detected_ran = std::cell::Cell::new(false);

        let attribution = select_claude_process_attribution(
            mapped,
            exact,
            None,
            None,
            None,
            &excluded,
            never_stale,
            || {
                detected_ran.set(true);
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &excluded,
                )
            },
        );

        assert!(!detected_ran.get());
        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude",
                "pinned-session".to_string(),
            ))
        );
    }

    #[test]
    fn rollover_never_adopts_a_session_another_pane_owns() {
        // Same cwd, two panes. Pane A's transcript is silent and pane B's is the
        // newest file in the directory, but B's id is mapped to B, so the
        // successor scan must not hand it to A.
        let (_root, claude_dir, claude_codex_dir) = claude_family_dirs();
        write_claude_jsonl(&claude_dir.join("pane-a-session.jsonl"), r"C:\Users\miyaz\work");
        wait_for_distinct_mtime();
        write_claude_jsonl(&claude_dir.join("pane-b-session.jsonl"), r"C:\Users\miyaz\work");
        let mappings = HashMap::from([
            (
                "pane-a".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: "pane-a-session".to_string(),
                },
            ),
            (
                "pane-b".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: "pane-b-session".to_string(),
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
        assert!(excluded.contains("pane-b-session"));
        let exact = Some("pane-a-session".to_string());
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
            |_kind, _session_id| true,
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

        let attribution = attribution.unwrap();
        assert_ne!(attribution.session_id, "pane-b-session");
        assert_eq!(attribution.session_id, "pane-a-session");
    }

    #[test]
    fn a_silent_pin_survives_when_no_successor_exists() {
        // Giving up on the id would blank the pane's chat column; a frozen
        // transcript is still better than none.
        let (_root, claude_dir, claude_codex_dir) = claude_family_dirs();
        let excluded = HashSet::new();
        let mappings = HashMap::from([(
            "pane-a".to_string(),
            AgentSessionMapping {
                agent_kind: Some("claude".to_string()),
                session_id: "pinned-session".to_string(),
            },
        )]);
        let mapped = mapped_agent_session_attribution_for_pane(
            &mappings,
            "pane-a",
            DetectedAgentKind::Claude,
            &excluded,
            None,
        );

        let attribution = select_claude_process_attribution(
            mapped,
            None,
            None,
            None,
            None,
            &excluded,
            |_kind, _session_id| true,
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
                "pinned-session".to_string(),
            ))
        );
    }

    #[test]
    fn a_confirmed_mapping_survives_a_frozen_argv_id() {
        // The tick after a rollover was applied: argv still carries the old id
        // forever, so it must not drag the pane back to the frozen transcript.
        let excluded = HashSet::new();
        let mappings = HashMap::from([(
            "pane-a".to_string(),
            AgentSessionMapping {
                agent_kind: Some("claude".to_string()),
                session_id: "successor-session".to_string(),
            },
        )]);
        let exact = Some("pinned-session".to_string());
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
            |_kind, session_id| session_id == "pinned-session",
            || -> Option<AgentSessionAttribution> {
                panic!("a live mapping must not trigger a successor scan")
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude",
                "successor-session".to_string(),
            ))
        );
    }

    #[test]
    fn a_session_switch_needs_two_identical_observations() {
        let mut pending = HashMap::new();
        let agent_pid = Pid::from_u32(404);
        let pinned = AgentSessionAttribution::new("claude", "pinned-session".to_string());
        let successor = AgentSessionAttribution::new("claude", "successor-session".to_string());

        let first = confirm_agent_session_switch(
            &mut pending,
            "pane-a",
            agent_pid,
            Some(&pinned),
            Some(successor.clone()),
        );
        assert_eq!(first.attribution, Some(pinned.clone()));
        assert_eq!(first.switched_from, None);
        assert!(pending.contains_key("pane-a"));

        let second = confirm_agent_session_switch(
            &mut pending,
            "pane-a",
            agent_pid,
            Some(&pinned),
            Some(successor.clone()),
        );
        assert_eq!(second.attribution, Some(successor));
        assert_eq!(second.switched_from.as_deref(), Some("pinned-session"));
        assert!(!pending.contains_key("pane-a"));
    }

    #[test]
    fn an_unclaimed_neighbour_session_is_dropped_before_the_switch_lands() {
        // Tick 1 sees another lane's brand-new transcript before that lane has
        // claimed it. Tick 2 the owner has claimed it, so the proposal reverts
        // to the pinned id and the pane never moves.
        let mut pending = HashMap::new();
        let agent_pid = Pid::from_u32(404);
        let pinned = AgentSessionAttribution::new("claude", "pinned-session".to_string());
        let neighbour = AgentSessionAttribution::new("claude", "neighbour-session".to_string());

        let first = confirm_agent_session_switch(
            &mut pending,
            "pane-a",
            agent_pid,
            Some(&pinned),
            Some(neighbour),
        );
        assert_eq!(first.attribution, Some(pinned.clone()));

        let second = confirm_agent_session_switch(
            &mut pending,
            "pane-a",
            agent_pid,
            Some(&pinned),
            Some(pinned.clone()),
        );
        assert_eq!(second.attribution, Some(pinned));
        assert_eq!(second.switched_from, None);
        assert!(!pending.contains_key("pane-a"));
    }

    #[test]
    fn a_restarted_agent_process_does_not_confirm_an_older_proposal() {
        let mut pending = HashMap::new();
        let pinned = AgentSessionAttribution::new("claude", "pinned-session".to_string());
        let successor = AgentSessionAttribution::new("claude", "successor-session".to_string());

        confirm_agent_session_switch(
            &mut pending,
            "pane-a",
            Pid::from_u32(404),
            Some(&pinned),
            Some(successor.clone()),
        );
        let after_restart = confirm_agent_session_switch(
            &mut pending,
            "pane-a",
            Pid::from_u32(505),
            Some(&pinned),
            Some(successor),
        );

        assert_eq!(after_restart.attribution, Some(pinned));
        assert_eq!(after_restart.switched_from, None);
    }

    #[test]
    fn a_pane_without_a_pin_switches_without_confirmation() {
        let mut pending = HashMap::new();
        let detected = AgentSessionAttribution::new("claude", "detected-session".to_string());

        let selection = confirm_agent_session_switch(
            &mut pending,
            "pane-a",
            Pid::from_u32(404),
            None,
            Some(detected.clone()),
        );

        assert_eq!(selection.attribution, Some(detected));
        assert_eq!(selection.switched_from, None);
        assert!(pending.is_empty());
    }

    #[test]
    fn a_transcript_is_silent_only_after_the_grace_period() {
        let now = std::time::SystemTime::now();
        assert!(!transcript_is_silent(None, now));
        assert!(!transcript_is_silent(Some(now), now));
        assert!(!transcript_is_silent(
            now.checked_sub(AGENT_TRANSCRIPT_SILENCE_GRACE / 2),
            now
        ));
        assert!(transcript_is_silent(
            now.checked_sub(AGENT_TRANSCRIPT_SILENCE_GRACE),
            now
        ));
        assert!(transcript_is_silent(
            now.checked_sub(AGENT_TRANSCRIPT_SILENCE_GRACE * 10),
            now
        ));
    }

    #[test]
    fn the_successor_scan_floor_never_drops_below_the_agent_start() {
        let now = std::time::SystemTime::now();
        let agent_started = now.checked_sub(Duration::from_secs(3_600)).unwrap();
        let pinned_last_write = now.checked_sub(Duration::from_secs(600)).unwrap();

        assert_eq!(successor_scan_floor(Some(agent_started), None), Some(agent_started));
        assert_eq!(successor_scan_floor(None, None), None);
        assert_eq!(
            successor_scan_floor(None, Some(pinned_last_write)),
            pinned_last_write.checked_sub(SUCCESSOR_CREATION_SLACK)
        );
        // The pinned transcript went silent long after the agent started, so the
        // floor rises to that moment: a file created while the pinned
        // conversation was alive cannot be its continuation.
        assert_eq!(
            successor_scan_floor(Some(agent_started), Some(pinned_last_write)),
            pinned_last_write.checked_sub(SUCCESSOR_CREATION_SLACK)
        );
        // A transcript that fell silent before the process started (a resume
        // handing over yesterday's id) must not lower the floor.
        let stale_last_write = now.checked_sub(Duration::from_secs(86_400)).unwrap();
        assert_eq!(
            successor_scan_floor(Some(agent_started), Some(stale_last_write)),
            Some(agent_started)
        );
    }

    #[test]
    fn the_successor_scan_floor_excludes_older_transcripts_from_the_scan() {
        let (_root, claude_dir, claude_codex_dir) = claude_family_dirs();
        write_claude_jsonl(&claude_dir.join("older-session.jsonl"), r"C:\Users\miyaz\work");
        let floor = std::time::SystemTime::now()
            .checked_add(Duration::from_secs(60))
            .unwrap();

        assert_eq!(
            detect_claude_family_session_id_in_dirs(
                &claude_dir,
                &claude_codex_dir,
                r"C:\Users\miyaz\work",
                Some(floor),
                &HashSet::new(),
            ),
            None
        );
    }

    #[test]
    fn transcript_paths_reject_ids_that_could_escape_the_project_dir() {
        assert!(claude_family_transcript_path("claude", r"C:\work", "..\\..\\etc").is_none());
        assert!(claude_family_transcript_path("claude", r"C:\work", "not-a-uuid").is_none());
        assert!(claude_family_transcript_path(
            "codex",
            r"C:\work",
            "401caf0d-c8d1-4c12-b0d4-ed291d41d356"
        )
        .is_none());
        let claude = claude_family_transcript_path(
            "claude",
            r"C:\work",
            "401caf0d-c8d1-4c12-b0d4-ed291d41d356",
        )
        .unwrap();
        assert!(claude.ends_with("401caf0d-c8d1-4c12-b0d4-ed291d41d356.jsonl"));
        assert!(claude.to_string_lossy().contains("C--work"));
        let claude_codex = claude_family_transcript_path(
            "claude-codex",
            r"C:\work",
            "401caf0d-c8d1-4c12-b0d4-ed291d41d356",
        )
        .unwrap();
        assert!(claude_codex.to_string_lossy().contains("claude-codex"));
    }
