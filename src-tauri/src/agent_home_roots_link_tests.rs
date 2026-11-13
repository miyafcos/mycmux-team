//! FIX-2B-1: real symlinks inside isolated temporary fixtures only.
use super::*;
use std::os::unix::fs::symlink;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const ID: &str = "11111111-1111-4111-8111-111111111111";
pub(crate) const PROMPT: &str = "linked global fixture prompt";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LinkMode { Root, Ancestor, Nested }
pub(crate) const MODES: [LinkMode;3] = [LinkMode::Root,LinkMode::Ancestor,LinkMode::Nested];
pub(crate) struct Fixture {
    pub dir: tempfile::TempDir,
    pub root: RecordRoot,
    pub source: PathBuf,
    pub started_at: u64,
    pub cwd: &'static str,
}
impl Fixture {
    pub fn new(mode: LinkMode) -> Self {
        let dir=tempfile::tempdir().unwrap();
        let real=dir.path().join("real/.codex/sessions");
        let path=real.join(format!("2026/11/12/rollout-2026-11-12T00-00-00-{ID}.jsonl"));
        let started_at=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        let stamp=chrono::DateTime::from_timestamp_millis(started_at as i64).unwrap().to_rfc3339();
        let cwd="C:/fixture/cwd";
        write(&path,&[
            serde_json::json!({"type":"session_meta","timestamp":stamp,"payload":{"id":ID,"session_id":ID,"cwd":cwd,"source":"cli"}}),
            serde_json::json!({"type":"response_item","timestamp":stamp,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":PROMPT}]}}),
            serde_json::json!({"type":"event_msg","timestamp":stamp,"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12},"last_token_usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}}),
            serde_json::json!({"type":"event_msg","timestamp":stamp,"payload":{"type":"task_started","turn_id":"fixture-turn"}}),
        ]);
        fs::File::options().write(true).open(&path).unwrap().set_modified(UNIX_EPOCH+Duration::from_secs(1000)).unwrap();
        let visible=dir.path().join("visible/.codex/sessions");
        match mode {
            LinkMode::Root => {fs::create_dir_all(visible.parent().unwrap()).unwrap();symlink(&real,&visible).unwrap();},
            LinkMode::Ancestor => symlink(dir.path().join("real"),dir.path().join("visible")).unwrap(),
            LinkMode::Nested => {fs::create_dir_all(&visible).unwrap();symlink(real.join("2026"),visible.join("2026")).unwrap();},
        }
        let source=visible.join(path.strip_prefix(&real).unwrap());
        Self {dir,root:RecordRoot {origin:Origin::Global,path:visible},source,started_at,cwd}
    }
}
pub(crate) fn write(path: &Path, records: &[serde_json::Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path,records.iter().map(|value|value.to_string()+"\n").collect::<String>()).unwrap();
}

#[tokio::test]
async fn fix2b1_ailog_global_root_and_ancestor_links_keep_the_legacy_file_type_walk() {
    use crate::ailog::index::{run_index,IndexOptions};
    use std::sync::atomic::AtomicBool;
    for mode in MODES {
        let f=Fixture::new(mode);let db=f.dir.path().join("index.db");
        let mut options=IndexOptions::new(db.clone());options.roots=vec![("codex",f.root.path.clone())];
        let report=run_index(options,Arc::new(AtomicBool::new(false)),None).await.unwrap();
        assert!(report.errors.is_empty(),"{mode:?}: {:?}",report.errors);
        let expected=i64::from(mode!=LinkMode::Nested);
        assert_eq!(crate::ailog::open_db(&db).unwrap().query_row("SELECT COUNT(*) FROM session",[],|row|row.get::<_,i64>(0)).unwrap(),expected,"{mode:?}");
    }
}

#[test]
fn fix2b1_account_base_and_ancestor_links_are_allowed_but_the_container_boundary_is_strict() {
    for ancestor in [true,false] {
        let dir=tempfile::tempdir().unwrap();let real_base=dir.path().join("real/base");
        let real_home=real_base.join("cli_account_homes/codex/codex-A");
        let real_source=real_home.join(format!("sessions/rollout-{ID}.jsonl"));write(&real_source,&[serde_json::json!({"type":"session_meta","payload":{"id":ID}})]);
        let base=if ancestor {symlink(dir.path().join("real"),dir.path().join("alias")).unwrap();dir.path().join("alias/base")}
            else {symlink(&real_base,dir.path().join("alias-base")).unwrap();dir.path().join("alias-base")};
        let aliased=base.join("cli_account_homes/codex/codex-A/sessions").join(format!("rollout-{ID}.jsonl"));
        assert!(record_path_allowed(&aliased));
        let roots=catalog_at(Some(&base),CliProvider::Codex,Vec::new());assert_eq!(roots.len(),2);
        assert_eq!(find_unique(&roots,CliProvider::Codex,ID).unwrap().unwrap().1,real_source.canonicalize().unwrap());
        let nested=real_home.join("sessions/inside");symlink(real_home.join("sessions"),&nested).unwrap();
        assert!(!record_path_allowed(&nested.join(format!("rollout-{ID}.jsonl"))));
    }
}

#[test]
fn fix2b1_account_mirror_gate_ignores_ancestors_but_refuses_inner_links() {
    let dir=tempfile::tempdir().unwrap();let tier=dir.path().join("real");
    let root=tier.join("accounts/codex/codex-A/sessions");fs::create_dir_all(&root).unwrap();
    symlink(&tier,dir.path().join("alias")).unwrap();
    let via=dir.path().join("alias/accounts/codex/codex-A/sessions");
    assert!(account_record_path(&via));assert!(record_path_allowed(&via));
    symlink(&root,root.join("linked")).unwrap();assert!(!record_path_allowed(&via.join("linked/missing.jsonl")));
}

#[test]
fn fix2b1_ailog_archive_walk_keeps_linked_global_roots_and_skips_nested_symlinks() {
    for mode in MODES {
        let f=Fixture::new(mode);let gz=f.source.with_extension("jsonl.gz");fs::write(&gz,b"archive fixture").unwrap();
        let mut paths=Vec::new();crate::ailog::index::collect_archive_jsonl(&f.root.path,&mut paths,None);
        assert_eq!(paths.len(),usize::from(mode!=LinkMode::Nested),"{mode:?}");
    }
}
