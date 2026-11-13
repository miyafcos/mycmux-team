use super::*;
use std::sync::atomic::AtomicBool;
use crate::ailog::{index::{run_index, IndexOptions}, mirror::{self, FreeSpace, MirrorConfig}, transcript::source::{self, SourceConfig}};

const IDS: [&str; 3] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
fn put(path: &Path, text: &str) { fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(path, text).unwrap(); }
fn global(temp: &Path, provider: CliProvider) -> Vec<RecordRoot> {
    roots_at_home(provider, &temp.join(if provider == CliProvider::Codex { "global/.codex" } else { "global/.grok" }), Origin::Global)
}
fn fixture(temp: &Path, provider: CliProvider) -> Vec<RecordRoot> {
    let kind = account_homes::provider_name(provider).unwrap();
    for id in [format!("{kind}-A"),format!("{kind}-B")] {
        fs::create_dir_all(temp.join("base/cli_account_homes").join(kind).join(id)).unwrap();
    }
    catalog_at(Some(&temp.join("base")), provider, global(temp, provider))
}
fn rollout(root: &RecordRoot, id: &str, text: &str) -> PathBuf {
    let path = root.path.join("2026/11/12").join(format!("rollout-2026-11-12T00-00-00-{id}.jsonl"));
    put(&path, &format!("{}\n{}\n{}\n", serde_json::json!({"type":"session_meta","timestamp":"2026-11-12T00:00:00Z","payload":{"id":id,"cwd":"/same/cwd","source":"cli"}}),
        serde_json::json!({"type":"response_item","timestamp":"2026-11-12T00:00:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}),
        serde_json::json!({"type":"event_msg","timestamp":"2026-11-12T00:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":2,"cached_input_tokens":0,"total_tokens":12},"last_token_usage":{"input_tokens":10,"output_tokens":2,"cached_input_tokens":0,"total_tokens":12}}}})));
    path
}
#[test]
fn catalog_keeps_unregistered_homes_and_no_base_means_global_only() {
    let dir = tempfile::tempdir().unwrap();
    for provider in [CliProvider::Codex,CliProvider::Grok] {
        let roots = fixture(dir.path(), provider);
        assert_eq!(roots.len(), if provider == CliProvider::Codex { 6 } else { 3 });
        assert!(roots.iter().any(|root| matches!(&root.origin, Origin::AccountHome {profile_id,..} if profile_id.ends_with("-B"))));
        assert!(!dir.path().join("base/cli_account_homes/manifest.json").exists());
        assert_eq!(catalog_at(None, provider, global(dir.path(), provider)), global(dir.path(), provider));
        let invalid = dir.path().join("base/cli_account_homes").join(account_homes::provider_name(provider).unwrap()).join("invalid-name");
        fs::create_dir_all(invalid).unwrap();
        assert_eq!(fixture(dir.path(), provider), roots);
    }
}
#[test]
fn unique_id_search_includes_codex_archived_sessions_and_refuses_global_priority() {
    let dir = tempfile::tempdir().unwrap(); let roots = fixture(dir.path(), CliProvider::Codex);
    let home_archive = roots.iter().find(|root| matches!(root.origin, Origin::AccountHome {..}) && root.path.ends_with("archived_sessions")).unwrap();
    let expected = rollout(home_archive, IDS[0], "archive");
    assert_eq!(find_unique(&roots, CliProvider::Codex, IDS[0]).unwrap().unwrap().1, expected);
    rollout(&roots[0], IDS[0], "global");
    assert_eq!(find_unique(&roots, CliProvider::Codex, IDS[0]).unwrap_err(), AMBIGUOUS);
    assert!(find_unique(&roots, CliProvider::Codex, "../escape").unwrap().is_none());
}
#[test]
fn grok_home_sessions_are_cataloged_and_unique_ids_are_checked() {
    let dir = tempfile::tempdir().unwrap(); let roots = fixture(dir.path(), CliProvider::Grok);
    let expected = roots[1].path.join("encoded-cwd/grok-one/updates.jsonl"); put(&expected,"{}\n");
    assert_eq!(find_unique(&roots, CliProvider::Grok,"grok-one").unwrap().unwrap().1, expected);
    put(&roots[2].path.join("encoded-cwd/grok-one/updates.jsonl"),"{}\n");
    assert_eq!(find_unique(&roots, CliProvider::Grok,"grok-one").unwrap_err(), AMBIGUOUS);
}
#[cfg(unix)]
#[test]
fn catalog_and_walk_never_enter_links_inside_or_outside_the_base() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap(); let roots = fixture(dir.path(), CliProvider::Codex);
    let outside = dir.path().join("outside"); fs::create_dir(&outside).unwrap();
    let parent = dir.path().join("base/cli_account_homes/codex");
    symlink(&outside,parent.join("codex-outside")).unwrap();
    symlink(parent.join("codex-A"),parent.join("codex-inside")).unwrap();
    let after = catalog_at(Some(&dir.path().join("base")),CliProvider::Codex,global(dir.path(),CliProvider::Codex));
    assert_eq!(after,roots);
    let home = roots.iter().find(|root| matches!(root.origin,Origin::AccountHome {..}) && root.path.ends_with("sessions")).unwrap();
    fs::create_dir_all(&home.path).unwrap();
    put(&outside.join(format!("rollout-{}.jsonl",IDS[0])),"{}\n");
    symlink(&outside,home.path.join("nested")).unwrap();
    symlink(outside.join(format!("rollout-{}.jsonl",IDS[0])),home.path.join(format!("rollout-{}.jsonl",IDS[0]))).unwrap();
    symlink(&outside,home.path.parent().unwrap().join("skills")).unwrap();
    assert!(find_unique(&after,CliProvider::Codex,IDS[0]).unwrap().is_none());
    let redirected = dir.path().join("redirected"); fs::create_dir_all(&redirected).unwrap();
    symlink(dir.path().join("base/cli_account_homes"),redirected.join("cli_account_homes")).unwrap();
    assert_eq!(catalog_at(Some(&redirected),CliProvider::Codex,global(dir.path(),CliProvider::Codex)),global(dir.path(),CliProvider::Codex));
}
#[tokio::test]
async fn ailog_indexes_global_and_two_homes_once_with_unchanged_global_totals() {
    let dir = tempfile::tempdir().unwrap(); let roots = fixture(dir.path(),CliProvider::Codex);
    let active: Vec<_> = roots.iter().filter(|root| root.path.ends_with("sessions")).cloned().collect();
    for (root,id) in active.iter().zip(IDS) { rollout(root,id,"hello"); }
    let db = dir.path().join("index.db");
    let mut options = IndexOptions::new(db.clone()); options.roots = vec![("codex",active[0].path.clone())];
    let first = run_index(options, Arc::new(AtomicBool::new(false)),None).await.unwrap(); assert!(first.errors.is_empty(),"{:?}",first.errors);
    let conn = crate::ailog::open_db(&db).unwrap();
    let global_before: (i64,i64) = conn.query_row("SELECT COUNT(*),SUM(input_tokens) FROM turn WHERE session_id=?1",[IDS[0]],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(global_before,(1,10));
    drop(conn);
    let mut options = IndexOptions::new(db.clone()); options.roots = roots.iter().map(|root|("codex",root.path.clone())).collect(); options.roots.push(("codex",active[0].path.clone()));
    let report = run_index(options.clone(),Arc::new(AtomicBool::new(false)),None).await.unwrap(); assert!(report.errors.is_empty(),"{:?}",report.errors);
    assert_eq!(report.files_done,2);
    let conn = crate::ailog::open_db(&db).unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM session",[],|r|r.get::<_,i64>(0)).unwrap(),3);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM source_file",[],|r|r.get::<_,i64>(0)).unwrap(),3);
    assert_eq!(conn.query_row("SELECT COUNT(*),SUM(input_tokens) FROM turn WHERE session_id=?1",[IDS[0]],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).unwrap(),global_before);
    drop(conn);
    assert_eq!(run_index(options,Arc::new(AtomicBool::new(false)),None).await.unwrap().files_done,0);
}
#[tokio::test]
async fn ailog_indexes_grok_homes_and_ignores_sibling_telemetry() {
    let dir = tempfile::tempdir().unwrap(); let roots = fixture(dir.path(),CliProvider::Grok);
    for (index,root) in roots.iter().enumerate() {
        let session = format!("grok-{index}"); let folder = root.path.join("encoded-cwd").join(&session);
        put(&folder.join("updates.jsonl"),&format!("{}\n",serde_json::json!({"params":{"sessionId":session,"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello"}}}})));
        put(&folder.join("events.jsonl"),"{}\n");
    }
    let mut options = IndexOptions::new(dir.path().join("index.db")); options.roots=roots.iter().map(|root|("grok",root.path.clone())).collect();
    let db=options.db_path.clone(); let report=run_index(options,Arc::new(AtomicBool::new(false)),None).await.unwrap();
    assert!(report.errors.is_empty(),"{:?}",report.errors); assert_eq!(report.files_done,3);
    assert_eq!(crate::ailog::open_db(&db).unwrap().query_row("SELECT COUNT(*) FROM session WHERE kind='grok'",[],|r|r.get::<_,i64>(0)).unwrap(),3);
}
struct Plenty;
impl FreeSpace for Plenty { fn available_bytes(&self,_:&Path)->Option<u64>{Some(u64::MAX)} }
#[test]
fn ailog_mirror_separates_same_relative_paths_and_recovery_keeps_provenance() {
    let dir=tempfile::tempdir().unwrap(); let roots=fixture(dir.path(),CliProvider::Codex);
    let active:Vec<_>=roots.iter().filter(|root|root.path.ends_with("sessions")).cloned().collect();
    let paths:Vec<_>=active.iter().enumerate().map(|(index,root)|rollout(root,IDS[0],&format!("home-{index}"))).collect();
    let tier=dir.path().join("mirror");
    let config=MirrorConfig {sources:active.iter().map(|root|("codex",root.path.clone())).collect(),tier1_root:dir.path().join("metadata"),tier2_root:Some(tier.clone()),state_path:dir.path().join("state.json")};
    let report=mirror::run_once_with(&config,&Plenty); assert!(report.errors.is_empty(),"{:?}",report.errors);assert_eq!(report.tier2_written,3);
    let destinations:Vec<_>=active.iter().zip(&paths).map(|(root,path)|mirror::mirror_destination(&root.path,path,&tier,"codex").unwrap()).collect();
    assert_eq!(destinations[0],tier.join("codex/2026/11/12").join(format!("rollout-2026-11-12T00-00-00-{}.jsonl.gz",IDS[0])));
    for (index,path) in destinations.iter().enumerate(){assert!(path.is_file());let mut text=String::new();crate::ailog::jsonl::for_each_line(path,crate::ailog::jsonl::Budget {max_bytes:1024*1024,max_lines:100},|line|{text.push_str(line);std::ops::ControlFlow::Continue(())}).unwrap();assert!(text.contains(&format!("home-{index}")));}
    assert!(destinations[1].starts_with(tier.join("accounts/codex/codex-A/sessions")));
    assert!(destinations[2].starts_with(tier.join("accounts/codex/codex-B/sessions")));
    let config=SourceConfig {roots:active.iter().map(|root|("codex".into(),root.path.clone())).collect(),archive:None,full_text:Some(tier),claude_fallback:None};
    let error=source::load_paths("codex",IDS[0],false,&paths,&config).unwrap_err();assert_eq!(error.code,AMBIGUOUS);
    for path in &paths {fs::rename(path,path.with_extension("moved")).unwrap();}
    let candidates=source::candidates("codex",&[paths[1].clone()],false,&config);assert!(candidates.contains(&destinations[1]));assert!(!candidates.contains(&destinations[0]));
    let own=SourceConfig {roots:vec![("codex".into(),active[1].path.clone())],..config};
    assert!(source::load_paths("codex",IDS[0],false,&[paths[1].clone()],&own).is_ok());
}

#[test]
fn tab_roots_are_exclusive_and_dead_pty_context_is_never_used() {
    let dir=tempfile::tempdir().unwrap();
    for provider in [CliProvider::Codex,CliProvider::Grok] {
        let roots=fixture(dir.path(),provider);let global=global(dir.path(),provider);
        let home=roots.iter().find(|r|matches!(r.origin,Origin::AccountHome {..})).unwrap().path.parent().unwrap().to_path_buf();
        let selected=select_session_roots(provider,global.clone(),true,||Ok(Some(account_homes::test_context(provider,home.clone())))).unwrap();
        assert!(selected.iter().all(|root|root.path.starts_with(&home)));
        assert_eq!(select_session_roots(provider,global.clone(),true,||Ok(None)).unwrap(),global);
        assert_eq!(select_session_roots(provider,global.clone(),false,||panic!("stale runtime context must not be read")).unwrap(),global);
        assert!(select_session_roots(provider,global.clone(),true,||Err("invalid home".into())).is_err());
        if provider==CliProvider::Grok {
            for (index,root) in roots.iter().enumerate(){put(&root.path.join(format!("cwd/grok-{index}/updates.jsonl")),"{}\n");}
            assert!(find_unique(&selected,provider,"grok-1").unwrap().is_some());
            assert!(find_unique(&selected,provider,"grok-0").unwrap().is_none());
            assert!(find_unique(&selected,provider,"grok-2").unwrap().is_none());
            assert!(find_unique(&global,provider,"grok-1").unwrap().is_none());
        }
    }
}

#[test]
fn default_tab_without_runtime_context_never_probes_a_missing_application_base() {
    let dir=tempfile::tempdir().unwrap();let base=dir.path().join("not-created");
    let id=format!("fixture-default-{}",uuid::Uuid::new_v4());
    assert!(account_homes::record_context_for_session(&base,&id).unwrap().is_none());
    assert!(!base.exists());
}

#[test]
fn fixr_r05_same_origin_duplicates_are_allowed_in_sessions_archives_and_one_account_home() {
    let dir = tempfile::tempdir().unwrap();
    let roots = global(dir.path(), CliProvider::Codex);
    let first = rollout(&roots[0], IDS[0], "sessions");
    rollout(&roots[1], IDS[0], "archive");
    put(&roots[0].path.join(format!("rollout-duplicate-{}.jsonl", IDS[0])), "{}\n");
    let found = find_unique(&roots, CliProvider::Codex, IDS[0]).unwrap().unwrap();
    assert_eq!(found.0.origin, Origin::Global);
    assert!(found.1.is_file());
    let all = fixture(dir.path(), CliProvider::Codex);
    let own: Vec<_> = all.into_iter().filter(|root| matches!(&root.origin, Origin::AccountHome { profile_id, .. } if profile_id == "codex-A")).collect();
    rollout(&own[0], IDS[1], "home sessions"); rollout(&own[1], IDS[1], "home archive");
    assert!(find_unique(&own, CliProvider::Codex, IDS[1]).unwrap().is_some());
    assert_eq!(reject_home_session(&own, CliProvider::Codex, IDS[1]).unwrap_err(), HOME_SESSION_UNSUPPORTED);
    assert!(first.is_file());
}

#[test]
fn fixr_r05_global_and_home_or_two_homes_stay_ambiguous() {
    for include_global in [false, true] {
        let dir = tempfile::tempdir().unwrap(); let roots = fixture(dir.path(), CliProvider::Codex);
        let selected: Vec<_> = roots.iter().filter(|root| root.path.ends_with("sessions")
            && (include_global || !matches!(root.origin, Origin::Global))).cloned().collect();
        for root in &selected { rollout(root, IDS[0], "different origin"); }
        assert_eq!(find_unique(&selected, CliProvider::Codex, IDS[0]).unwrap_err(), AMBIGUOUS);
        assert_eq!(reject_home_session(&selected, CliProvider::Codex, IDS[0]).unwrap_err(), HOME_SESSION_UNSUPPORTED);
    }
}

#[test]
fn fixr_r05_each_global_root_is_walked_once_for_unique_and_duplicate_ids() {
    let dir = tempfile::tempdir().unwrap(); let roots = global(dir.path(), CliProvider::Codex);
    let expected = rollout(&roots[0], IDS[0], "unique");
    for duplicate in [false, true] {
        if duplicate { rollout(&roots[1], IDS[0], "same origin"); }
        let mut visits = Vec::new();
        let found = find_unique_with_global(&roots, CliProvider::Codex, IDS[0], |root| {
            visits.push(root.to_path_buf()); let mut files = Vec::new(); collect_files(root, &mut files, None); files
        }, |_, _| false).unwrap().unwrap();
        assert_eq!(visits, roots.iter().map(|root| root.path.clone()).collect::<Vec<_>>());
        assert_eq!(found.1, expected);
    }
}
