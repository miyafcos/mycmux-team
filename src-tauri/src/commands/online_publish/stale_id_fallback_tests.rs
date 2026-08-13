    use super::*;
    use tempfile::tempdir;

    #[test]
    fn locate_falls_back_to_latest_when_requested_id_has_no_transcript() {
        let temp = tempdir().unwrap();
        let projects = temp.path();
        let project_dir = projects.join(sanitize_project_dir("C:/work/demo"));
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(project_dir.join("real-session.jsonl"), "{}\n").unwrap();

        let (path, session_id) =
            crate::agent_transcript::locate_claude_transcript(projects, "C:/work/demo", Some("ghost-session")).unwrap();
        assert_eq!(session_id, "real-session");
        assert!(path.ends_with("real-session.jsonl"));
    }

    #[test]
    fn locate_still_errors_when_no_transcript_exists_at_all() {
        let temp = tempdir().unwrap();
        let projects = temp.path();
        fs::create_dir_all(projects.join(sanitize_project_dir("C:/work/empty"))).unwrap();

        let result = crate::agent_transcript::locate_claude_transcript(projects, "C:/work/empty", Some("ghost-session"));
        assert!(result.is_err());
    }
