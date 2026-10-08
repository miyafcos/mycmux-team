use super::*;
use std::fs;
use std::sync::mpsc;
use std::time::Duration;
use tempfile::TempDir;

struct Fixture {
    _directory: TempDir,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let home = safe::canonical(directory.path());
        let result = std::process::Command::new(if cfg!(windows) { "python" } else { "python3" })
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/agent_home/prepare_home.py"))
            .arg(&home).args(["--variant", "both"]).output().unwrap();
        assert!(result.status.success(), "synthetic fixture generator failed");
        Self { _directory: directory, home }
    }

    fn catalog(&self) -> Catalog {
        refresh_catalog(&self.home, &self.home, &self.home.join(".codex"),
            &self.home.join(".hermes"), (Some("synthetic".into()), Some("synthetic".into()))).unwrap()
    }

    fn folder(&self, name: &str) -> PathBuf {
        let path = self.home.join(name);
        fs::create_dir(&path).unwrap();
        path
    }

    fn history(&self) -> Cache {
        serde_json::from_slice(&fs::read(state_dir(&self.home).join("cache.json")).unwrap()).unwrap()
    }
}

fn at_folder(mut catalog: Catalog, path: &Path) -> Catalog {
    catalog.cwd = path.to_string_lossy().into();
    catalog.work_folder = catalog.cwd.clone();
    catalog
}

#[test]
fn shared_refresh_enqueues_history_for_home_and_project() {
    let f = Fixture::new();
    let project = f.folder("history-project");
    for cwd in [&f.home, &project] {
        let catalog = refresh_catalog(&f.home, cwd, &f.home.join(".codex"),
            &f.home.join(".hermes"), (Some("synthetic".into()), Some("synthetic".into()))).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let history = super::super::history::timeline(&f.home, cwd).unwrap();
            if !history.writing && history.snapshot_count == 1 {
                assert!(history.warnings.is_empty(), "{:?}", history.warnings);
                assert!(history.captured_at.is_some());
                assert_eq!(catalog.cwd, cwd.to_string_lossy());
                break;
            }
            assert!(Instant::now() < deadline, "shared refresh failed to write metadata history");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn refresh_arguments_accept_null_home_and_a_known_history_folder_only() {
    let f = Fixture::new();
    assert_eq!(work_folder(&f.home, &json!({"workFolder": null})).unwrap(), f.home);
    assert_eq!(work_folder(&f.home, &json!({"workFolder": f.home})).unwrap(), f.home);
    assert_eq!(work_folder(&f.home, &json!({"workFolder": f.home.join(".")})).unwrap(), f.home);
    let project = f.folder("known-folder");
    let catalog = at_folder(f.catalog(), &project);
    save(&f.home, &catalog).unwrap();
    assert_eq!(work_folder(&f.home, &json!({"workFolder": project})).unwrap(), project);
    let unknown = f.folder("never-seen");
    assert_eq!(work_folder(&f.home, &json!({"workFolder": unknown})).unwrap_err(), "workFolderUnknown");
    assert_eq!(work_folder(&f.home, &json!({"workFolder": "relative"})).unwrap_err(), "workFolderUnknown");
}

#[test]
fn refresh_arguments_reject_wrong_types_and_a_missing_work_folder() {
    let f = Fixture::new();
    for args in [Value::Null, json!([]), json!("home"), json!({}), json!({"workFolder": 7}),
        json!({"workFolder": true}), json!({"workFolder": []}), json!({"workFolder": {}})] {
        assert_eq!(work_folder(&f.home, &args).unwrap_err(), "workFolderInvalid");
    }
}

#[test]
fn refresh_rejects_broken_foreign_and_unsupported_history() {
    let f = Fixture::new();
    let project = f.folder("project");
    let catalog = at_folder(f.catalog(), &project);
    let directory = state_dir(&f.home);
    for value in [
        json!({"schemaVersion": 999, "contexts": [catalog]}),
        json!({"schemaVersion": 1, "contexts": [{"schemaVersion": 1, "home": "foreign", "cwd": project,
            "workFolder": project, "generator": "mycmux/synthetic"}]}),
        json!({"schemaVersion": 1, "contexts": [{"schemaVersion": 1, "home": f.home, "cwd": "mismatch",
            "workFolder": project, "generator": "mycmux/synthetic"}]}),
    ] {
        safe::write_json(&directory, "cache.json", &value).unwrap();
        assert_eq!(work_folder(&f.home, &json!({"workFolder": project})).unwrap_err(), "workFolderUnknown");
        assert_eq!(work_folder(&f.home, &json!({"workFolder": null})).unwrap(), f.home);
    }
    fs::write(directory.join("cache.json"), "broken-json").unwrap();
    assert_eq!(work_folder(&f.home, &json!({"workFolder": project})).unwrap_err(), "workFolderUnknown");
}

#[tokio::test]
async fn refresh_acknowledges_without_waiting_and_coalesces_duplicate_and_ui_waiters() {
    let f = Fixture::new();
    let jobs = Arc::new(RefreshJobs::default());
    let (entered, entering) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let home = f.home.clone();
    let start = Instant::now();
    let cwd = work_folder(&home, &json!({"workFolder": null})).unwrap();
    let first = jobs.start("synthetic-home".into(), move || {
        entered.send(()).unwrap();
        released.recv_timeout(Duration::from_secs(5)).unwrap();
        refresh_catalog(&home, &cwd, &home.join(".codex"), &home.join(".hermes"),
            (Some("synthetic".into()), Some("synthetic".into())))
    }).unwrap();
    let elapsed = start.elapsed();
    assert!(elapsed < Duration::from_millis(100), "ack took {elapsed:?}");
    let acknowledgement = first.acknowledgement();
    assert_eq!(acknowledgement["accepted"], true);
    assert!(chrono::DateTime::parse_from_rfc3339(acknowledgement["startedAt"].as_str().unwrap()).is_ok());
    entering.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(!state_dir(&f.home).join("catalog.json").exists());
    let second = jobs.start("synthetic-home".into(), || panic!("duplicate work started")).unwrap();
    assert!(Arc::ptr_eq(&first.job, &second.job));
    assert_eq!(second.acknowledgement(), json!({"accepted": true, "alreadyRunning": true}));
    println!("new command acknowledgement_ms={:.3}", elapsed.as_secs_f64() * 1000.0);
    println!("NEW_SOCKET_REPLY={}", serde_json::to_string(&crate::socket::SocketResponse {
        id: 7, result: Some(acknowledgement), error: None,
    }).unwrap());
    println!("DUPLICATE_SOCKET_REPLY={}", serde_json::to_string(&crate::socket::SocketResponse {
        id: 8, result: Some(second.acknowledgement()), error: None,
    }).unwrap());
    release.send(()).unwrap();
    let (fresh, ui) = tokio::join!(first.wait(), second.wait());
    let fresh = fresh.unwrap();
    assert_eq!(fresh.generated_at, ui.unwrap().generated_at);
    assert_eq!(serde_json::to_value(&fresh).unwrap(), safe::json(&state_dir(&f.home).join("catalog.json")).unwrap());
    assert!(f.history().contexts.iter().any(|context| context.cwd == fresh.cwd));
    assert_eq!(memory_snapshot(&f.home).unwrap().generated_at, fresh.generated_at);
    let text = serde_json::to_string(&fresh).unwrap();
    assert!(!text.contains("CANARY_SECRET_7F3A") && !text.contains("CANARY_BODY_9C1D"));
    assert!(jobs.running.lock().unwrap().is_empty());
}

#[tokio::test]
async fn refresh_can_restart_after_completion_failure_or_worker_panic() {
    let f = Fixture::new();
    let catalog = f.catalog();
    let jobs = Arc::new(RefreshJobs::default());
    let failed = jobs.start("retry".into(), || Err("serializationFailed".into())).unwrap();
    assert_eq!(failed.wait().await.unwrap_err(), "serializationFailed");
    assert!(jobs.running.lock().unwrap().is_empty());
    let panicked = jobs.start("retry".into(), || panic!("synthetic worker panic")).unwrap();
    assert!(panicked.wait().await.unwrap_err().starts_with("join agent_design_refresh:"));
    assert!(jobs.running.lock().unwrap().is_empty());
    for _ in 0..2 {
        let expected = catalog.clone();
        let finished = jobs.start("retry".into(), move || Ok(expected)).unwrap();
        assert!(!finished.already_running);
        assert_eq!(finished.wait().await.unwrap().generated_at, catalog.generated_at);
    }
}

#[test]
fn cache_evicts_old_folders_and_preserves_home_under_the_eight_folder_limit() {
    let f = Fixture::new();
    let home_catalog = f.catalog();
    for i in 0..9 {
        let folder = f.folder(&format!("project-{i}"));
        save(&f.home, &at_folder(home_catalog.clone(), &folder)).unwrap();
    }
    let cache = f.history();
    assert_eq!(cache.contexts.len(), 8);
    assert_eq!(cache.contexts.last().unwrap().cwd, home_catalog.cwd);
    assert_eq!(cache.contexts[0].work_folder, f.home.join("project-8").to_string_lossy());
    assert!(!cache.contexts.iter().any(|c| c.cwd.ends_with("project-0") || c.cwd.ends_with("project-1")));
    save(&f.home, &home_catalog).unwrap();
    assert_eq!(f.history().contexts.iter().filter(|c| c.cwd == home_catalog.cwd).count(), 1);
    println!("cache folder eviction: 10 requested contexts -> 8 retained; home retained");
}

#[test]
fn cache_preserves_home_under_the_real_32_mib_limit_even_when_newest_must_be_evicted() {
    let f = Fixture::new();
    let mut home_catalog = f.catalog();
    // Public prose keeps the byte-limit fixture large after secret redaction.
    let body = "Public.".repeat((2 * 1024 * 1024 - 256) / 7);
    for i in 0..9 {
        home_catalog.documents.insert(format!("synthetic-{i}"), json!({"id": format!("synthetic-{i}"),
            "body": body, "fields": [], "size": {"chars": body.len(), "lines": 1, "bytes": body.len()}, "status": "present"}));
    }
    save(&f.home, &home_catalog).unwrap();
    let folder = f.folder("large-project");
    let latest = at_folder(home_catalog.clone(), &folder);
    save(&f.home, &latest).unwrap();
    let cache = f.history();
    let bytes = fs::metadata(state_dir(&f.home).join("cache.json")).unwrap().len();
    assert!(bytes <= CACHE_BYTES);
    assert_eq!(cache.contexts.len(), 1);
    assert_eq!(cache.contexts[0].cwd, home_catalog.cwd);
    assert_eq!(safe::json(&state_dir(&f.home).join("catalog.json")).unwrap()["workFolder"], latest.work_folder);
    println!("cache byte eviction: cache_bytes={bytes}; limit={CACHE_BYTES}; home retained; latest catalog published");
}

#[test]
fn cache_without_home_keeps_the_existing_newest_first_policy() {
    let f = Fixture::new();
    let mut cache = Cache { schema_version: 1, contexts: vec![] };
    let base = f.catalog();
    for i in 0..8 {
        let path = f.folder(&format!("non-home-{i}"));
        cache.contexts.insert(0, at_folder(base.clone(), &path));
    }
    safe::write_json(&state_dir(&f.home), "cache.json", &cache).unwrap();
    let ninth = f.folder("non-home-8");
    save(&f.home, &at_folder(base, &ninth)).unwrap();
    let retained = f.history();
    assert_eq!(retained.contexts.len(), 8);
    assert!(!retained.contexts.iter().any(|c| c.cwd.ends_with("non-home-0")));
    assert_eq!(retained.contexts[0].cwd, ninth.to_string_lossy());
}
