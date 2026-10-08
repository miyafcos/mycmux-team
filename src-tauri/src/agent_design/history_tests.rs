use super::*;
use std::process::Command;
use std::time::{Duration, Instant};

const SECRET: &str = "CANARY_SECRET_7F3A";
const MEMORY: &str = "CANARY_MEMORY_4D8E";
struct Fixture { _temp: tempfile::TempDir, home: PathBuf }
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = safe::canonical(temp.path()).join("fixture-home");
        let f = Self { _temp: temp, home };
        f.prepare("initial"); f
    }
    fn prepare(&self, action: &str) {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/agent_home/prepare_history.py");
        let output = Command::new(if cfg!(windows) { "python" } else { "python3" }).args([script.to_str().unwrap(),self.home.to_str().unwrap(),action]).output().unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    }
    fn item(&self, service: &str, name: &str, layer: u8, kind: &str, allowed: bool) -> Item {
        let path = self.home.join(name);
        Item { id: format!("{service}:{kind}:{name}"),service:service.into(),layer,display_name:safe::basename(&path),path:Some(path.to_string_lossy().into()),
            kind:kind.into(),status: if path.exists() { "present" } else { "absent" }.into(), size:safe::size(&path,false),read_timing:"always".into(),
            evidence:"measured".into(),modified_at:safe::modified(&path),fields:vec![],conditions:vec![],document_allowed:allowed,active:path.exists() }
    }
    fn catalog(&self) -> Catalog {
        let mut catalog = Catalog { schema_version:1,generated_at:chrono::Utc::now().to_rfc3339(),generator:"mycmux/fixture".into(),
            home:self.home.to_string_lossy().into(),work_folder:self.home.to_string_lossy().into(),cwd:self.home.to_string_lossy().into(),refresh_ms:0.0,
            services:vec![],items:vec![],links:vec![],findings:vec![],closed_count:0,warnings:vec![],layers:vec![],reading_flows:vec![],compare_rows:vec![],documents:BTreeMap::new(),closed_revision:0, closed_entries: Some(vec![]) };
        for (name,kind,layer,allowed,service) in [
            ("CLAUDE.md","instruction",3,true,"claude"), (".claude/settings.json","settings",2,false,"claude"),
            (".claude/rules/review.md","rule",3,true,"claude"), (".claude/rules/renamed.md","rule",3,true,"claude"),
            (".claude/rules/new.md","rule",3,true,"claude"), (".codex/memories/MEMORY.md","memoryIndex",4,false,"codex"),
            (".codex/rules/default.rules","permissionRules",2,false,"codex"), (".codex/config.toml","settings",2,false,"codex"),
        ] {
            let item = self.item(service,name,layer,kind,allowed);
            if allowed && item.active { catalog.documents.insert(item.id.clone(),serde_json::json!({"body":safe::text(Path::new(item.path.as_ref().unwrap()),safe::DOCUMENT_LIMIT)})); }
            catalog.items.push(item);
        }
        for id in ["claude","codex","hermes"] {
            let mut service = Service::new(id,if id=="claude" { "Claude Code" } else if id=="codex" { "Codex" } else { "Hermes" },&self.home.join(format!(".{id}")));
            service.version=if id=="hermes" { None } else { Some("1.0.0".into()) };
            let chars = catalog.documents.values().filter_map(|v|v["body"].as_str()).map(|s|s.chars().count() as u64).sum::<u64>();
            if id!="hermes" {
                service.context.instructions=Some(chars); service.context.memory=Some(18); service.context.listing=Some(100); service.context.startup=Some(0);
                service.context.total=Some(chars+118); service.context.known_total=chars+118;
                service.session.listing.count=Some(2); service.session.listing.chars=Some(100);
            }
            catalog.services.push(service);
        }
        catalog
    }
    fn get(&self,name: &str,service: &str,kind: &str,layer: u8,allowed: bool) -> Item { self.item(service,name,layer,kind,allowed) }
}
fn git(f: &Fixture, item: &Item) -> GitHistory { git::list(&f.home,&f.home,item,&git::Runner::default()).unwrap() }
fn clean(value: &impl serde::Serialize) {
    let text=serde_json::to_string(value).unwrap(); assert!(!text.contains(SECRET)); assert!(!text.contains(MEMORY));
}
#[test]
fn git_commit_rename_follow_and_line_numbers() {
    let f=Fixture::new(); f.prepare("update");
    let item=f.get(".claude/rules/renamed.md","claude","rule",3,true);
    let log=git(&f,&item); assert_eq!(log.status,"ready"); assert_eq!(log.changes.len(),3);
    assert_eq!(log.changes[0].kind,"renamed"); assert_eq!(log.changes[2].kind,"added");
    let change=&log.changes[1];
    let diff=git::diff(&f.home,&f.home,&item,change.hash.as_ref().unwrap(),&git::Runner::default()).unwrap();
    assert_eq!(diff.mode,"text"); assert_eq!(diff.status,"ready");
    assert!(diff.lines.iter().any(|l|l.kind=="added" && l.new_line==Some(5) && l.text=="Check the changed lines."));
    assert!(diff.after_bytes.unwrap()>diff.before_bytes.unwrap()); clean(&log); clean(&diff);
    assert!(git::diff(&f.home,&f.home,&item,&"0".repeat(40),&git::Runner::default()).is_err());
    assert!(git::diff(&f.home,&f.home,&item,"HEAD~1",&git::Runner::default()).is_err());
}
#[test]
fn git_settings_diff_omits_env_mcp_and_hook_arguments() {
    let f=Fixture::new(); f.prepare("update"); let item=f.get(".claude/settings.json","claude","settings",2,false);
    let log=git(&f,&item); let diff=git::diff(&f.home,&f.home,&item,log.changes[0].hash.as_ref().unwrap(),&git::Runner::default()).unwrap();
    assert_eq!(diff.mode,"fields"); assert_eq!(diff.status,"ready"); clean(&diff);
    assert!(diff.lines.iter().any(|l|l.kind=="added" && l.text.contains("fixture-large")));
    let safe=git::fields("json",&fs::read_to_string(f.home.join(".claude/settings.json")).unwrap()).unwrap();
    assert!(safe.contains("fixture_hook.py")); assert!(!safe.contains(SECRET)); assert!(!safe.contains("Authorization")); assert!(!safe.contains("--token"));
    let toml=git::fields("toml",&fs::read_to_string(f.home.join(".codex/config.toml")).unwrap()).unwrap();
    assert!(toml.contains("mcp:fixture: false")); assert!(!toml.contains(SECRET));
}
#[test]
fn git_binary_and_memory_never_read_bodies() {
    let f=Fixture::new(); f.prepare("update");
    for (name,kind,layer) in [(".codex/rules/default.rules","permissionRules",2),(".codex/memories/MEMORY.md","memoryIndex",4)] {
        let item=f.get(name,"codex",kind,layer,false); let log=git(&f,&item);
        let diff=git::diff(&f.home,&f.home,&item,log.changes[0].hash.as_ref().unwrap(),&git::Runner::default()).unwrap();
        assert_eq!(diff.mode,"hidden"); assert!(diff.lines.is_empty()); assert!(diff.after_bytes.is_some()); clean(&diff);
    }
    let secret=f.get(".claude/auth.json","claude","settings",2,true);
    assert_eq!(git(&f,&secret).status,"historyDenied");
}
#[test]
fn git_renamed_memory_stays_hidden_and_unknown_author_stays_unknown() {
    let f=Fixture::new();
    let out=Command::new("git").args(["-C",f.home.to_str().unwrap(),"mv",".codex/memories/MEMORY.md",".claude/rules/moved.md"]).output().unwrap(); assert!(out.status.success());
    let out=Command::new("git").args(["-C",f.home.to_str().unwrap(),"-c","user.name=Fixture Writer","-c","user.email=writer@example.test","commit","-qm","Move fixture document"]).output().unwrap(); assert!(out.status.success());
    let item=f.get(".claude/rules/moved.md","claude","rule",3,true); let log=git(&f,&item);
    for change in &log.changes {
        let diff=git::diff(&f.home,&f.home,&item,change.hash.as_ref().unwrap(),&git::Runner::default()).unwrap();
        assert_eq!(diff.mode,"hidden"); clean(&diff);
    }
    let record=format!("{}\0\0{}\0\0Initial fixture\0\0\n:000000 100644 0000000 1234567 A\0CLAUDE.md\01\t0\tCLAUDE.md\0","a".repeat(40),"2026-10-01T01:02:03Z");
    let parsed=git::parse(record.as_bytes()).unwrap(); assert_eq!(git::changes(&item,parsed)[0].author,None);
}
#[test]
fn git_renamed_memory_is_not_projected_as_settings() {
    let f=Fixture::new();
    let memory=f.home.join(".codex/memories/private-note.json");
    fs::write(&memory,format!("{{\"model\":\"{MEMORY}\",\"env\":{{\"KEY\":\"{SECRET}\"}}}}")).unwrap();
    let run=|args:&[&str]| assert!(Command::new("git").arg("-C").arg(&f.home).args(args).status().unwrap().success());
    run(&["add",".codex/memories/private-note.json"]);
    run(&["-c","user.name=Fixture Writer","-c","user.email=writer@example.test","commit","-qm","Add fixture memory metadata"]);
    run(&["mv",".codex/memories/private-note.json",".claude/settings.local.json"]);
    run(&["-c","user.name=Fixture Writer","-c","user.email=writer@example.test","commit","-qm","Rename fixture memory to settings"]);
    let item=f.get(".claude/settings.local.json","claude","settingsLocal",2,false); let log=git(&f,&item);
    assert_eq!(log.changes.len(),2);
    for change in &log.changes {
        let diff=git::diff(&f.home,&f.home,&item,change.hash.as_ref().unwrap(),&git::Runner::default()).unwrap();
        assert_eq!(diff.mode,"hidden"); assert!(diff.lines.is_empty()); clean(&diff);
    }
}
#[test]
#[cfg(unix)]
fn historical_symlink_is_not_read_as_a_document() {
    let f=Fixture::new(); let path=f.home.join(".claude/rules/link.md");
    std::os::unix::fs::symlink("../../auth.json",&path).unwrap();
    let commit=|subject:&str| {
        assert!(Command::new("git").args(["-C",f.home.to_str().unwrap(),"add",".claude/rules/link.md"]).status().unwrap().success());
        assert!(Command::new("git").args(["-C",f.home.to_str().unwrap(),"-c","user.name=Fixture Writer","-c","user.email=writer@example.test","commit","-qm",subject]).status().unwrap().success());
    };
    commit("Add fixture link"); fs::remove_file(&path).unwrap(); fs::write(&path,"Public fixture rule").unwrap(); commit("Replace fixture link");
    let item=f.get(".claude/rules/link.md","claude","rule",3,true); let log=git(&f,&item);
    let diff=git::diff(&f.home,&f.home,&item,log.changes[0].hash.as_ref().unwrap(),&git::Runner::default()).unwrap();
    assert_eq!(diff.mode,"hidden"); assert!(diff.lines.is_empty());
}
#[test]
fn git_without_repository_or_executable_is_a_safe_empty_state() {
    let temp=tempfile::tempdir().unwrap(); let home=safe::canonical(temp.path()); let path=home.join("CLAUDE.md"); fs::write(&path,"fixture").unwrap();
    // Isolate this synthetic folder from a real home repository in its ancestors.
    fs::write(home.join(".git"),"gitdir: missing-fixture-repository\n").unwrap();
    let f=Fixture::new(); let mut item=f.get("CLAUDE.md","claude","instruction",3,true); item.path=Some(path.to_string_lossy().into());
    assert_eq!(git::list(&home,&home,&item,&git::Runner::default()).unwrap().status,"noRepository");
    let runner=git::Runner { executable:home.join("missing-git"),timeout:Duration::from_secs(1) };
    assert_eq!(git::list(&home,&home,&item,&runner).unwrap().status,"gitUnavailable");
}
#[test]
#[cfg(unix)]
fn git_timeout_is_bounded_and_reaps_the_child() {
    use std::os::unix::fs::PermissionsExt;
    let f=Fixture::new(); let script=f.home.join("slow-git"); fs::write(&script,"#!/bin/sh\nexec /bin/sleep 2\n").unwrap(); fs::set_permissions(&script,fs::Permissions::from_mode(0o700)).unwrap();
    let runner=git::Runner { executable:script,timeout:Duration::from_millis(80) }; let start=Instant::now();
    let result=git::list(&f.home,&f.home,&f.get("CLAUDE.md","claude","instruction",3,true),&runner).unwrap();
    assert_eq!(result.status,"timeout"); assert!(start.elapsed()<Duration::from_millis(800));
}
#[test]
fn snapshot_metadata_hashes_only_allowed_docs_and_omits_private_paths() {
    let f=Fixture::new(); let mut catalog=f.catalog();
    for name in [".env","credentials.json","auth.json","token.txt","fixture.key","fixture.pem","tokens/fixture.txt"] {
        catalog.items.push(f.get(&format!(".claude/{name}"),"claude","rule",3,true));
    }
    let memory=catalog.items.iter_mut().find(|i|i.layer==4).unwrap(); memory.document_allowed=true;
    catalog.documents.insert(memory.id.clone(),serde_json::json!({"body":MEMORY}));
    let snapshot=capture(&catalog); clean(&snapshot);
    assert!(snapshot.items.iter().filter(|i|i.layer==4).all(|i|i.document_hash.is_none()));
    assert!(snapshot.items.iter().find(|i|i.kind=="settings").unwrap().document_hash.is_none());
    assert!(snapshot.items.iter().any(|i|i.kind=="rule" && i.document_hash.as_ref().is_some_and(|s|s.len()==64)));
    assert!(snapshot.items.iter().all(|i|!safe::private(Path::new(&i.path))));
    let serialized=serde_json::to_value(snapshot).unwrap(); assert!(serialized.get("body").is_none());
}
#[test]
fn snapshot_tracks_memory_body_metadata_without_opening_or_hashing_it() {
    let f=Fixture::new(); let path=f.home.join(".codex/memories/private-note.md"); fs::write(&path,MEMORY).unwrap();
    fs::write(f.home.join(".codex/memories/auth.json"),SECRET).unwrap();
    let catalog=f.catalog(); safe::OPENED.with(|paths|paths.borrow_mut().clear());
    let before=capture(&catalog); safe::OPENED.with(|paths|assert!(paths.borrow().is_empty()));
    let item=before.items.iter().find(|i|safe::same_path(Path::new(&i.path),&path)).unwrap(); assert_eq!(item.kind,"memoryFile"); assert!(item.document_hash.is_none()); clean(&before);
    fs::write(&path,format!("{MEMORY}\nAdditional private note.")).unwrap(); let after=capture(&catalog); clean(&after);
    let changes=compare(&before,&after); assert!(changes.iter().any(|c|c.item_id.as_ref()==Some(&item.id) && c.after_bytes>c.before_bytes));
    assert!(before.items.iter().all(|i|!i.path.ends_with("auth.json")));
    write(&directory(&f.home),&before).unwrap(); write(&directory(&f.home),&after).unwrap();
    let log=git_history(&f.home,&f.home,&catalog,&item.id).unwrap(); assert_eq!(log.status,"ready");
    let diff=git_diff(&f.home,&f.home,&catalog,&item.id,log.changes[0].hash.as_ref().unwrap()).unwrap();
    assert_eq!(diff.mode,"hidden"); clean(&diff);
}
#[test]
fn unavailable_memory_metadata_does_not_invent_a_deletion() {
    let f=Fixture::new(); let path=f.home.join(".codex/memories/private-note.md"); fs::write(&path,MEMORY).unwrap();
    let before=capture(&f.catalog()); let mut after=before.clone(); after.items.retain(|i|i.kind!="memoryFile"); after.memory_unavailable.push("codex".into());
    assert!(compare(&before,&after).iter().all(|c|c.layer!=4));
    let mut legacy=before.clone(); legacy.items.retain(|i|i.kind!="memoryFile"); legacy.memory_inventory.clear();
    assert!(compare(&legacy,&before).iter().all(|c|c.layer!=4));
}
#[test]
fn snapshot_windows_path_spelling_does_not_invent_a_file_change() {
    let f=Fixture::new(); let mut before=capture(&f.catalog()); before.items.truncate(1);
    before.items[0].path="C:\\Users\\Fixture\\CLAUDE.md".into(); let mut after=before.clone(); after.items[0].path="c:/users/fixture/CLAUDE.md".into();
    assert!(compare(&before,&after).is_empty()); assert_eq!(folder_key(Path::new(&before.items[0].path)),folder_key(Path::new(&after.items[0].path)));
}
#[test]
fn snapshot_extended_length_windows_spellings_preserve_history_identity() {
    let f = Fixture::new();
    let mut before = capture(&f.catalog());
    before.items.truncate(1);
    for (ordinary, extended) in [
        (r"C:\MYCMUX_MISSING_HISTORY_0860\CLAUDE.md", r"\\?\c:\mycmux_missing_history_0860\CLAUDE.md"),
        ("c:/MYCMUX_MISSING_HISTORY_0860/CLAUDE.md", "//?/C:/mycmux_missing_history_0860/claude.md"),
    ] {
        before.items[0].path = ordinary.into();
        let mut after = before.clone();
        after.items[0].path = extended.into();
        assert!(compare(&before, &after).is_empty());
        assert_eq!(
            folder_key(Path::new(ordinary)),
            folder_key(Path::new(extended))
        );
        after.items[0].path.push_str(".different");
        assert_eq!(compare(&before, &after).len(), 1);
        assert_ne!(
            folder_key(Path::new(ordinary)),
            folder_key(Path::new(&after.items[0].path))
        );
    }
}

#[test]
fn snapshots_write_read_and_compare_added_deleted_changed_and_amounts() {
    let f=Fixture::new(); let first=capture(&f.catalog()); let root=directory(&f.home); let first_path=write(&root,&first).unwrap();
    assert_eq!(serde_json::from_slice::<Snapshot>(&fs::read(&first_path).unwrap()).unwrap().items,first.items);
    assert_eq!(timeline(&f.home,&f.home).unwrap().snapshot_count,1); assert!(timeline(&f.home,&f.home).unwrap().changes.is_empty());
    f.prepare("update"); let mut catalog=f.catalog(); catalog.services[0].session.listing.count=Some(3); catalog.services[0].session.listing.chars=Some(140);
    let second=capture(&catalog); write(&root,&second).unwrap(); let timeline=timeline(&f.home,&f.home).unwrap();
    assert_eq!(timeline.snapshot_count,2); clean(&timeline);
    for kind in ["added","deleted","changed"] { assert!(timeline.changes.iter().any(|c|c.kind==kind)); }
    let amount=timeline.changes.iter().find(|c|c.badge=="readAmountChanged" && c.service=="claude").unwrap();
    assert!(amount.amount_changes.iter().any(|a|a.key=="listingCount" && a.before==Some(2) && a.after==Some(3)));
    assert!(amount.amount_changes.iter().any(|a|a.key=="listingChars" && a.after==Some(140)));
    assert!(timeline.changes.iter().any(|c|c.layer==4 && c.badge=="fileChanged"));
    assert!(target(&f.home,&f.home,&catalog,&first.items.iter().find(|i|i.path.ends_with("/review.md")).unwrap().id).is_ok());
}
#[test]
fn snapshots_prune_to_sixty_per_folder() {
    let f=Fixture::new(); let snapshot=capture(&f.catalog()); let root=directory(&f.home);
    let folder=root.join(&snapshot.work_folder_key); fs::create_dir_all(&folder).unwrap();
    let unrelated=folder.join("user-note.json"); fs::write(&unrelated,"preserve this unrelated file").unwrap();
    for _ in 0..63 { write(&root,&snapshot).unwrap(); }
    assert_eq!(files(&root).unwrap().len(),60); assert_eq!(timeline(&f.home,&f.home).unwrap().snapshot_count,60);
    assert!(unrelated.exists());
}
#[test]
fn snapshots_prune_oldest_across_folders_under_twenty_megabytes() {
    let f=Fixture::new(); let mut snapshot=capture(&f.catalog()); let root=directory(&f.home);
    snapshot.items[0].display_name="x".repeat(7*1024*1024);
    let mut paths=vec![];
    for key in ["1","2","3"] { snapshot.work_folder_key=key.repeat(64); paths.push(write(&root,&snapshot).unwrap()); }
    assert!(!paths[0].exists()); assert!(paths[1].exists() && paths[2].exists());
    assert!(files(&root).unwrap().iter().map(|(_,n)|n).sum::<u64>()<=TOTAL_LIMIT);
}
#[test]
#[cfg(unix)]
fn redirected_history_storage_is_denied() {
    let f=Fixture::new(); let temp=tempfile::tempdir().unwrap(); let root=directory(&f.home);
    fs::create_dir_all(root.parent().unwrap()).unwrap(); std::os::unix::fs::symlink(temp.path(),&root).unwrap();
    assert!(write(&root,&capture(&f.catalog())).is_err()); assert!(timeline(&f.home,&f.home).is_err());
}
#[test]
fn snapshot_corruption_is_reported_without_original_file_reads() {
    let f=Fixture::new(); let path=write(&directory(&f.home),&capture(&f.catalog())).unwrap();
    fs::write(&path,b"unsupported").unwrap(); let result=timeline(&f.home,&f.home).unwrap();
    assert!(result.changes.is_empty()); assert_eq!(result.warnings,vec!["historyUnsupported"]);
}
#[test]
fn newline_only_change_and_large_diff_are_bounded() {
    let (lines,truncated)=git::lines("a\nb\n","a\nb\nc\n"); assert!(!truncated);
    assert_eq!(lines.iter().find(|l|l.kind=="added").unwrap().new_line,Some(3));
    let (lines,truncated)=git::lines("",&"long line\n".repeat(1000)); assert!(truncated); assert_eq!(lines.len(),500);
}
#[test]
#[ignore = "explicit offline acceptance evidence export"]
fn export_history_acceptance() {
    let output=PathBuf::from(std::env::var_os("MYCMUX_HISTORY_EVIDENCE").expect("explicit evidence directory"));
    assert!(output.is_absolute() && output.is_dir());
    let f=Fixture::new(); let first=capture(&f.catalog()); write(&directory(&f.home),&first).unwrap();
    f.prepare("update"); let catalog=f.catalog(); write(&directory(&f.home),&capture(&catalog)).unwrap();
    let emit=|name:&str,value:serde_json::Value| { clean(&value); let path=output.join(name); assert!(!path.exists()); fs::write(path,serde_json::to_vec(&value).unwrap()).unwrap(); };
    emit("synthetic-catalog.json",serde_json::to_value(&catalog).unwrap());
    emit("synthetic-history.json",serde_json::to_value(timeline(&f.home,&f.home).unwrap()).unwrap());
    let mut logs=BTreeMap::new(); let mut diffs=BTreeMap::new();
    let mut targets:Vec<_>=catalog.items.iter().filter(|i|i.status=="present").cloned().collect();
    for item in capture(&catalog).items.iter().filter(|i|i.kind=="memoryFile") { targets.push(target(&f.home,&f.home,&catalog,&item.id).unwrap()); }
    for item in &targets {
        let log=git(&f,item);
        for change in &log.changes { let diff=git::diff(&f.home,&f.home,item,change.hash.as_ref().unwrap(),&git::Runner::default()).unwrap(); diffs.insert(change.id.clone(),diff); }
        logs.insert(item.id.clone(),log);
    }
    emit("synthetic-git.json",serde_json::to_value(logs).unwrap()); emit("synthetic-diffs.json",serde_json::to_value(diffs).unwrap());
    emit("synthetic-snapshots.json",serde_json::to_value(snapshots(&directory(&f.home),&f.home).unwrap().0).unwrap());
    if let Some(input)=std::env::var_os("MYCMUX_HISTORY_LIVE_INPUT") {
        let input=PathBuf::from(input); assert!(input.is_absolute() && input.is_dir());
        let normalize=|catalog: &mut Catalog| {
            catalog.home=catalog.home.replace('\\',"/"); catalog.cwd=catalog.cwd.replace('\\',"/"); catalog.work_folder=catalog.work_folder.replace('\\',"/");
            for item in &mut catalog.items { if let Some(p)=item.path.as_mut() { *p=p.replace('\\',"/"); } }
        };
        let mut before:Catalog=serde_json::from_slice(&fs::read(input.join("live-catalog-input.json")).unwrap()).unwrap(); normalize(&mut before);
        let mut after:Catalog=serde_json::from_slice(&fs::read(input.join("live-catalog-metadata-current.json")).unwrap()).unwrap(); normalize(&mut after);
        let live_home=output.join("live-state"); let root=directory(&live_home); let cwd=Path::new(&after.cwd);
        write(&root,&capture(&before)).unwrap(); write(&root,&capture(&after)).unwrap();
        emit("live-catalog.json",serde_json::to_value(&after).unwrap());
        emit("live-history.json",serde_json::to_value(timeline(&live_home,cwd).unwrap()).unwrap());
        emit("live-snapshots.json",serde_json::to_value(snapshots(&root,cwd).unwrap().0).unwrap());
        let source:serde_json::Value=serde_json::from_slice(&fs::read(input.join("live-git-input.json")).unwrap()).unwrap();
        let mut logs=BTreeMap::new(); let mut diffs=BTreeMap::new();
        for record in source["records"].as_array().unwrap() {
            let mut item:Item=serde_json::from_value(record["item"].clone()).unwrap(); item.path=item.path.map(|p|p.replace('\\',"/"));
            let hex=record["rawLogHex"].as_str().unwrap();
            let raw:Vec<u8>=hex.as_bytes().chunks_exact(2).map(|c|u8::from_str_radix(std::str::from_utf8(c).unwrap(),16).unwrap()).collect();
            let changes=git::changes(&item,git::parse(&raw).unwrap());
            if let Some(change)=changes.first() {
                if let Some(body)=record["afterBody"].as_str() {
                    let (lines,truncated)=git::lines(record["beforeBody"].as_str().unwrap_or(""),body);
                    diffs.insert(change.id.clone(),HistoryDiff { mode:"text".into(),status:"ready".into(),lines,truncated,
                        before_bytes:record["beforeBytes"].as_u64(),after_bytes:record["afterBytes"].as_u64() });
                }
            }
            logs.insert(item.id.clone(),GitHistory { status:if changes.is_empty() { "noCommits" } else { "ready" }.into(),changes });
        }
        emit("live-git.json",serde_json::to_value(logs).unwrap()); emit("live-diffs.json",serde_json::to_value(diffs).unwrap());
    }
}

#[test]
fn v04_snapshot_pair_selects_exact_scope_and_rejects_invalid_order() {
    let f = Fixture::new(); let mut a = capture(&f.catalog());
    a.captured_at = "2026-10-01T00:00:00Z".into();
    let mut b = a.clone(); b.captured_at = "2026-10-02T00:00:00Z".into(); b.items[0].bytes = Some(900);
    let mut c = b.clone(); c.captured_at = "2026-10-03T00:00:00Z".into();
    for value in [&a, &b, &c] { write(&directory(&f.home), value).unwrap(); }
    let h = timeline(&f.home, &f.home).unwrap();
    assert_eq!(h.snapshots.len(), 3); assert_eq!(h.snapshots[0].item_count, a.items.len());
    assert_eq!(h.snapshots[0].services.len(), 3);
    assert_eq!(pair(&f.home, &f.home, &a.captured_at, &b.captured_at).unwrap().len(), 1);
    assert!(pair(&f.home, &f.home, &b.captured_at, &c.captured_at).unwrap().is_empty());
    assert!(pair(&f.home, &f.home, &c.captured_at, &a.captured_at).is_err());
    assert!(pair(&f.home, &f.home, "missing", &c.captured_at).is_err());
    let other = f.home.join("other-work-folder"); fs::create_dir(&other).unwrap();
    assert!(pair(&f.home, &other, &a.captured_at, &b.captured_at).is_err());
}
#[test]
fn v04_history_masks_full_multiline_sides_before_line_diff() {
    let before = format!("auth:\n  value: {SECRET}\npublic: first\n");
    let after = format!("auth:\n  value: {SECRET}\npublic: second\n");
    let (lines, _) = git::lines(&before, &after); clean(&lines);
    assert!(lines.iter().any(|line| line.kind == "added" && line.text == "public: second"));
    assert!(lines.iter().any(|line| line.text.contains(super::super::redaction::PLACEHOLDER)));
}
#[test]
fn v04_untracked_and_ignored_files_are_distinct_from_no_changes() {
    let f = Fixture::new(); fs::write(f.home.join(".gitignore"), ".claude/settings.local.json\n").unwrap();
    fs::write(f.home.join(".claude/settings.local.json"), "{}").unwrap();
    fs::write(f.home.join(".claude/rules/untracked.md"), "Public rule").unwrap();
    assert_eq!(git(&f, &f.get(".claude/settings.local.json", "claude", "settingsLocal", 2, false)).status, "ignored");
    assert_eq!(git(&f, &f.get(".claude/rules/untracked.md", "claude", "rule", 3, true)).status, "untracked");
}
