use super::*;
use super::book::DocumentChoice;
use serde_json::json;
use std::collections::BTreeMap;

fn item(id: &str, kind: &str, layer: u8, path: &str, allowed: bool) -> Item {
    Item { id: id.into(), service: "claude".into(), layer, display_name: id.into(), path: Some(path.into()), kind: kind.into(), status: "present".into(), size: Size { chars: Some(100), lines: Some(4), bytes: Some(100) }, read_timing: "always".into(), evidence: "declaration".into(), modified_at: None, fields: vec![], conditions: vec![], document_allowed: allowed, active: true }
}
fn fixture() -> Catalog {
    let mut catalog = Catalog {
        schema_version: 1, generated_at: "2026-10-07T10:00:00+09:00".into(), generator: "mycmux/0.84.1".into(),
        home: "/Users/fictional".into(), work_folder: "/Users/fictional".into(), cwd: "/Users/fictional".into(), refresh_ms: 1.,
        services: vec![Service::new("claude","Claude Code",Path::new("/Users/fictional/.claude")),Service::new("codex","Codex",Path::new("/Users/fictional/.codex")),Service::new("hermes","Hermes",Path::new("/Users/fictional/.hermes"))],
        items: vec![
            item("rule", "rule", 3, "/Users/fictional/.claude/rules/public.md", true),
            item("instruction", "instruction", 3, "/Users/fictional/.claude/CLAUDE.md", true),
            item("memory", "memoryIndex", 4, "/Users/fictional/.claude/projects/p/memory/MEMORY.md", true),
            item("settings", "settings", 2, "/Users/fictional/.claude/settings.json", false),
            item("skill", "skill", 5, "/Users/fictional/.claude/skills/check/SKILL.md", false),
            item("private", "privateCount", 2, "/Users/fictional/.claude/auth.json", false),
        ],
        links: vec![], findings: vec![], closed_count: 0, warnings: vec!["CANARY_BODY_9C1D".into()],
        layers: vec![], reading_flows: vec![], compare_rows: vec![], documents: BTreeMap::new(), closed_revision: 0, closed_entries: Some(vec![]),
    };
    for (id, body) in [
        ("rule", "# Public\nUse a repeatable check.\n"),
        ("instruction", "# Public heading\nPUBLIC_SECTION\n## Private heading\nPRIVATE_SECTION_BODY\n"),
        ("memory", "CANARY_MEMORY_4D8E\n"),
        ("settings", "CANARY_SECRET_7F3A\n"),
    ] { catalog.documents.insert(id.into(),json!({"body":body})); }
    catalog.services[0].session.startup_hooks.push(Field::new("output", "CANARY_BODY_9C1D"));
    catalog.services[0].session.file = Some("CANARY_BODY_9C1D.jsonl".into());
    catalog.services[0].context.memory = Some(93847);
    catalog.items[3].fields = vec![Field::new("env","CANARY_SECRET_7F3A"),Field::new("mcp:value","CANARY_SECRET_7F3A"),Field::new("hook:Stop","CANARY_SECRET_7F3A"),Field::new("model","synthetic-model")];
    catalog
}
fn prepare(c: &Catalog, choices: Vec<DocumentChoice>) -> ExportPreview {
    book::prepare(c,&ExportOptions { documents: choices, ..Default::default() },&[],&["fictional".into()]).unwrap()
}
fn whole(id: &str) -> DocumentChoice { DocumentChoice { id: id.into(), sections: None } }
#[test]
fn omissions_locate_same_named_documents_and_count_memory_once() {
    let mut c = fixture();
    c.items[1].display_name = "CLAUDE.md".into();
    let mut other = item("other_instruction", "instruction", 3, "/Users/fictional/project/CLAUDE.md", true);
    other.display_name = "CLAUDE.md".into();
    c.items.push(other);
    c.items.push(item("other_memory", "memoryDirectory", 4, "/Users/fictional/.claude/projects/other/memory", false));
    for layers in [ExportOptions::default().layers, vec![3, 4]] {
        let p = book::prepare(&c, &ExportOptions { layers, ..Default::default() }, &[], &[]).unwrap();
        let memory: Vec<_> = p.omissions.iter().filter(|o| o.label == "記憶と記録").collect();
        assert_eq!(memory.len(), 1); assert_eq!(memory[0].count, 2); assert!(memory[0].reason.starts_with("いつも外す"));
        let paths: Vec<_> = p.omissions.iter().filter(|o| o.label == "CLAUDE.md").map(|o| o.path.as_deref().unwrap()).collect();
        assert_eq!(paths, vec!["~/.claude/CLAUDE.md", "~/project/CLAUDE.md"]);
        assert!(p.omissions.iter().all(|o| o.path.as_deref().is_none_or(|path| path.starts_with("~/"))));
        let serialized = serde_json::to_value(&p).unwrap();
        assert!(serialized["omissions"].as_array().unwrap().iter().any(|o| o["path"] == "~/.claude/CLAUDE.md"));
        let cover = p.html.split("<main>").next().unwrap();
        assert!(!cover.contains("CLAUDE.md"));
    }
}
#[test]
fn fully_unknown_sizes_are_hidden_but_partial_and_zero_sizes_remain() {
    let mut c = fixture();
    c.items[3].display_name = "unknown_size".into();
    c.items[3].size = Size { chars: None, lines: None, bytes: None };
    c.items[0].size = Size { chars: None, lines: None, bytes: Some(0) };
    let p = prepare(&c, vec![]);
    let unknown = p.html.split("<h4>unknown_size</h4>").nth(1).unwrap().split("</article>").next().unwrap();
    assert!(!unknown.contains("大きさ"));
    assert!(!p.html.contains("大きさ: 不明 字 / 不明 行 / 不明 バイト"));
    assert!(p.html.contains("大きさ: 0.00 KB"));
    assert!(!p.html.contains("不明 字"));
    assert!(!p.html.contains("不明 行"));
}
#[test]
fn defaults_exclude_memory_secrets_logs_and_all_bodies() {
    let p = prepare(&fixture(),vec![]);
    assert!(p.hits.is_empty(), "{:?}", p.hits);
    for marker in ["CANARY_SECRET_7F3A","CANARY_BODY_9C1D","CANARY_MEMORY_4D8E","93847","PUBLIC_SECTION","PRIVATE_SECTION_BODY"] { assert!(!p.html.contains(marker),"{marker}"); }
    assert_eq!(p.document_count,0);
    assert!(!p.html.contains("秘密: 0 件"));
    assert!(!p.html.contains("会話の本文・ログ: 0 件"));
    assert_eq!(p.omissions[..3].iter().map(|o|o.kind.as_str()).collect::<Vec<_>>(),vec!["memory","secret","conversation"]);
    assert!(p.html.find("id=\"omitted\"").unwrap() < p.html.find("<main>").unwrap());
    assert!(p.html.contains("synthetic-model"));
    assert!(!p.html.contains("/Users/fictional"));
}
#[test]
fn only_chosen_rule_body_is_included() {
    let p = prepare(&fixture(),vec![whole("rule")]);
    assert_eq!(p.document_count,1); assert!(p.html.contains("Use a repeatable check."));
    assert!(!p.html.contains("PRIVATE_SECTION_BODY"));
}
#[test]
fn memory_secret_and_unknown_document_choices_are_denied() {
    for id in ["memory","settings","private","missing"] {
        assert!(book::prepare(&fixture(),&ExportOptions { documents:vec![whole(id)],..Default::default() },&[],&[]).is_err());
    }
}
#[test]
fn instruction_requires_explicit_headings_and_excludes_others() {
    assert!(book::prepare(&fixture(),&ExportOptions { documents:vec![whole("instruction")],..Default::default() },&[],&[]).is_err());
    let c = fixture(); let doc = book::documents(&c).into_iter().find(|d|d.id=="instruction").unwrap();
    assert_eq!(doc.sections.len(),2);
    let p=prepare(&c,vec![DocumentChoice{id:"instruction".into(),sections:Some(vec![doc.sections[0].id.clone()])}]);
    assert!(p.html.contains("PUBLIC_SECTION")); assert!(!p.html.contains("PRIVATE_SECTION_BODY"));
    assert!(p.omissions.iter().any(|o|o.kind=="section"&&o.count==1));
}
#[test]
fn fences_and_setext_headings_do_not_overselect_bodies() {
    let mut c=fixture();
    c.documents.insert("instruction".into(),json!({"body":"Title\n=====\nOne\n```md\n# Fake heading\n```\n## Second\nTwo\n"}));
    let doc=book::documents(&c).into_iter().find(|d|d.id=="instruction").unwrap();
    assert_eq!(doc.sections.iter().map(|s|s.label.as_str()).collect::<Vec<_>>(),vec!["Title","Second"]);
    let p=prepare(&c,vec![DocumentChoice{id:"instruction".into(),sections:Some(vec![doc.sections[1].id.clone()])}]);
    assert!(p.html.contains("Two")); assert!(!p.html.contains("Fake heading"));
}
#[test]
fn relative_paths_cover_windows_mac_and_selected_prose() {
    assert_eq!(privacy::relative(r"C:\Users\fictional\.claude\x.md",r"C:\Users\fictional"),r"~/ .claude\x.md".replace("~/ ","~/"));
    assert_eq!(privacy::relative("/Users/another/.claude/x.md","/Users/fictional"),"~/.claude/x.md");
    assert_eq!(privacy::relative("/Users/fictionalized/file","/Users/fictional"),"~/file");
    assert_eq!(privacy::relative("/tmp/homework","/tmp/home"),"/tmp/homework");
}
#[test]
fn normalization_is_nfkc_and_unicode_case_insensitive() {
    for (a,b) in [("ＦＩＣＴＩＯＮＡＬ_ＰＥＲＳＯＮ","fictional_person"),("e\u{301}","é"),("ｶﾞ","ガ"),("ﬃ","ffi"),("Straße","STRASSE"),("가","가"),("ΟΣ","ος")] {
        assert_eq!(privacy::normalized(a),privacy::normalized(b),"{a}");
    }
}
#[test]
fn list_matches_encoded_entities_and_cross_line_html() {
    assert!(!privacy::scan("<p>ＦＩＣＴＩＯＮＡＬ_ＰＥＲＳＯＮ</p>",&["fictional_person".into()],&[]).is_empty());
    assert!(!privacy::scan("<p>O&#39;Brien</p>",&["O'Brien".into()],&[]).is_empty());
    assert!(!privacy::scan("<p title=\"&#70;ictional\">safe</p>",&["fictional".into()],&[]).is_empty());
    assert!(!privacy::scan("<p>Alpha\nBeta</p>",&["alpha\nbeta".into()],&[]).is_empty());
}
#[test]
fn builtins_detect_os_users_emails_and_phone_shapes() {
    for text in ["fictional","Contact user@example.test","Contact user@example.test.","ＵＳＥＲ＠ＥＸＡＭＰＬＥ．ＴＥＳＴ．","090-1234-5678","＋８１（９０）１２３４５６７８"] {
        assert!(!privacy::scan(text,&[],&["fictional".into()]).is_empty(),"{text}");
    }
    assert!(privacy::scan("scheduled 2026-10-07 0.84.1",&[],&["edu".into()]).is_empty());
    assert!(privacy::scan("0.2.0+codex.20260824160131 012345678 12",&[],&[]).is_empty());
    assert!(!privacy::scan("03-1234-5678 212-234-5678",&[],&[]).is_empty());
}
#[test]
fn hit_blocks_writing_and_preserves_existing_file() {
    let mut c=fixture(); c.documents.insert("rule".into(),json!({"body":"FICTIONAL_PERSON"}));
    let p=book::prepare(&c,&ExportOptions {documents:vec![whole("rule")],..Default::default()},&["fictional_person".into()],&[]).unwrap();
    let dir=tempfile::tempdir().unwrap(); let path=dir.path().join("blocked.html");
    assert_eq!(save_file(&path,&p,Path::new(&c.home),&[]).unwrap_err(),"exportNamesFound"); assert!(!path.exists());
    std::fs::write(&path,b"ORIGINAL").unwrap();
    assert!(save_file(&path,&p,Path::new(&c.home),&[]).is_err());
    assert_eq!(std::fs::read(path).unwrap(),b"ORIGINAL");
}
#[test]
fn html_is_one_offline_escaped_file() {
    use kuchikiki::traits::TendrilSink;
    let mut c=fixture(); c.documents.insert("rule".into(),json!({"body":"<script src=\"https://example.test/x\"></script>\nhttps://example.test/link"}));
    let p=prepare(&c,vec![whole("rule")]); let dom=kuchikiki::parse_html().one(p.html.clone()).document_node;
    for selector in ["script","link","img","iframe","object","embed","a"] { assert_eq!(dom.select(selector).unwrap().count(),0); }
    assert!(p.html.contains("&lt;script")); assert!(p.html.contains("@media(max-width:600px)"));
    assert!(!p.html.contains("url("));
}
#[test]
fn names_list_absent_empty_changes_and_invalid_encoding_fail_closed() {
    let dir=tempfile::tempdir().unwrap(); let root=safe::canonical(dir.path()); assert!(names(&root).unwrap().is_empty());
    let path=list_path(&root); std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path,"fictional_person\n").unwrap(); assert_eq!(names(&root).unwrap(),vec!["fictional_person"]);
    let mut c=fixture(); c.documents.insert("rule".into(),json!({"body":"FICTIONAL_PERSON"}));
    c.home=root.to_string_lossy().into(); c.cwd=c.home.clone(); c.work_folder=c.home.clone(); c.services[0].root=root.join(".claude").to_string_lossy().into();
    let rule=root.join(".claude/rules/public.md"); std::fs::create_dir_all(rule.parent().unwrap()).unwrap(); std::fs::write(&rule,"FICTIONAL_PERSON").unwrap();
    c.items[0].path=Some(rule.to_string_lossy().into());
    assert!(!preview(&root,c.clone(),&ExportOptions {documents:vec![whole("rule")],..Default::default()}).unwrap().hits.is_empty());
    std::fs::write(&path,"").unwrap(); assert!(preview(&root,c,&ExportOptions {documents:vec![whole("rule")],..Default::default()}).unwrap().hits.is_empty());
    std::fs::write(&path,[0xff]).unwrap(); assert!(names(&root).is_err());
}
#[test]
fn services_layers_and_invalid_or_stale_selections_are_bounded() {
    let c=fixture(); let p=book::prepare(&c,&ExportOptions {services:vec!["codex".into()],layers:vec![1],documents:vec![]},&[],&[]).unwrap();
    assert!(!p.html.contains("synthetic-model"));
    for options in [
        ExportOptions { services:vec![],..Default::default() }, ExportOptions { layers:vec![8],..Default::default() },
        ExportOptions { documents:vec![whole("rule"),whole("rule")],..Default::default() },
        ExportOptions { documents:vec![DocumentChoice{id:"instruction".into(),sections:Some(vec!["missing".into()])}],..Default::default() },
    ] { assert!(book::prepare(&c,&options,&[],&[]).is_err()); }
    assert_ne!(prepare(&c,vec![]).fingerprint,prepare(&c,vec![whole("rule")]).fingerprint);
}
#[test]
fn selected_body_redacts_secret_assignments_and_key_locations() {
    let mut c=fixture(); c.documents.insert("rule".into(),json!({"body":"Public line\nAPI_KEY=CANARY_SECRET_7F3A\nRead /Users/fictional/.codex/auth.json\n"}));
    let p=prepare(&c,vec![whole("rule")]);
    assert!(p.html.contains("Public line")); assert!(!p.html.contains("CANARY_SECRET_7F3A")); assert!(!p.html.contains("auth.json"));
    assert!(p.omissions.iter().any(|o|o.kind=="secretBody"&&o.count==2));
}
#[test]
fn safe_write_uses_html_only_and_never_overwrites_or_touches_configs() {
    let dir=tempfile::tempdir().unwrap(); let canonical=safe::canonical(dir.path()); let home=canonical.as_path(); let p=prepare(&fixture(),vec![]);
    let path=home.join("book.html"); save_file(&path,&p,home,&[]).unwrap(); assert_eq!(std::fs::read_to_string(&path).unwrap(),p.html);
    assert_eq!(save_file(&path,&p,home,&[]).unwrap_err(),"exportFileExists");
    assert!(save_file(&home.join(".claude/book.html"),&p,home,&[]).is_err());
    assert!(save_file(&home.join("book.txt"),&p,home,&[]).is_err());
}
#[test]
fn metadata_link_and_finding_evidence_never_export_private_bodies() {
    let mut c=fixture();
    c.findings.push(Finding{id:"f".into(),kind:"duplicate".into(),service:"claude".into(),layer:3,severity:"watch".into(),count:2,chars:Some(1),evidence:vec![Evidence{path:None,line:Some(1),record:Some("CANARY_BODY_9C1D".into()),rule:"CANARY_SECRET_7F3A".into(),fields:vec![]}],unknowns:vec![],proposal:"CANARY_BODY_9C1D".into(),item_ids:vec!["rule".into()],names:vec!["CANARY_BODY_9C1D".into()]});
    let p=prepare(&c,vec![]); assert!(p.html.contains("2 件")); assert!(p.html.contains("~/.claude/rules/public.md"));
    assert!(!p.html.contains("CANARY_BODY_9C1D")); assert!(!p.html.contains("CANARY_SECRET_7F3A"));
}
#[test]
fn synthetic_home_canaries_are_excluded_by_the_real_catalogue_pipeline() {
    let dir=tempfile::tempdir().unwrap(); let home=safe::canonical(&dir.path().join("home"));
    let status=std::process::Command::new(if cfg!(windows){"python"}else{"python3"}).arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/agent_home/prepare_export_home.py")).arg(&home).status().unwrap();
    assert!(status.success()); let home=safe::canonical(&home);
    let c=super::super::collect(&home,&home,&home.join(".codex"),&home.join(".hermes"),&super::super::scheduled::Jobs::default(),(None,None));
    let p=book::prepare(&c,&ExportOptions::default(),&[],&[]).unwrap();
    for marker in ["CANARY_SECRET_7F3A","CANARY_BODY_9C1D","CANARY_MEMORY_4D8E"] { assert!(!p.html.contains(marker)); }
    let rule=c.items.iter().find(|i|i.path.as_deref().is_some_and(|p|p.ends_with("export-name.md"))).unwrap();
    let p=book::prepare(&c,&ExportOptions {documents:vec![whole(&rule.id)],..Default::default()},&names(&home).unwrap(),&[]).unwrap();
    assert_eq!(p.hits.len(),1);
}

#[test]
fn comparison_uses_catalogue_roles_and_hermes_has_only_names_and_locations() {
    use super::super::portable::{CompareRow, CompareCell};
    let mut c=fixture();
    let mut h=item("hermes-config","settings",2,"/Users/fictional/.hermes/config.yaml",false);
    h.service="hermes".into(); h.status="absent".into(); c.items.push(h);
    c.compare_rows=vec![
        CompareRow{id:"permissions".into(),tag:"sameRole".into(),cells:vec![CompareCell{service:"claude".into(),state:"present".into(),item_ids:vec!["settings".into()],values:BTreeMap::new(),fields:vec![Field::new("approval_policy","never"),Field::new("env","CANARY_SECRET_7F3A")]}]},
        CompareRow{id:"memory".into(),tag:"sameRole".into(),cells:vec![CompareCell{service:"claude".into(),state:"present".into(),item_ids:vec!["memory".into()],values:BTreeMap::new(),fields:vec![]}]}
    ];
    let p=prepare(&c,vec![]);
    assert!(!p.html.contains("CANARY_SECRET_7F3A"));
    let comparison=p.html.split("<h2>比べる</h2>").nth(1).unwrap().split("<h2>").next().unwrap();
    assert!(comparison.contains("許可")); assert!(comparison.contains("approval_policy")); assert!(!comparison.contains("記憶と記録"));
    let hermes=p.html.split("<h2>Hermes</h2>").nth(1).unwrap().split("<h2>").next().unwrap();
    assert!(hermes.contains("~/.hermes/config.yaml")); assert!(hermes.contains("無し"));
    assert!(!hermes.contains("読まれる時期")); assert!(!hermes.contains("大きさ"));
}

#[test]
#[ignore = "manual acceptance: explicitly supplied PC catalogue and evidence only"]
fn export_pc_evidence() {
    let directory=PathBuf::from(std::env::var_os("MYCMUX_EXPORT_EVIDENCE").expect("explicit evidence directory")); assert!(directory.is_absolute()&&directory.is_dir());
    let c: Catalog=serde_json::from_slice(&std::fs::read(directory.join("pc-catalog.json")).unwrap()).unwrap();
    let names: Vec<String>=serde_json::from_slice(&std::fs::read(directory.join("acceptance-names.json")).unwrap()).unwrap();
    let chosen: Vec<String>=serde_json::from_slice(&std::fs::read(directory.join("chosen-rule-ids.json")).unwrap()).unwrap();
    assert_eq!(chosen.len(),2);
    // The source PC username, not the Mac test runner username, owns this book.
    let source_users=vec![c.home.replace('\\',"/").trim_end_matches('/').rsplit('/').next().unwrap().to_owned()];
    for (mode,choices) in [("default",vec![]),("one-rule",vec![whole(&chosen[0])]),("two-rules",chosen.iter().map(|id|whole(id)).collect())] {
        let p=book::prepare(&c,&ExportOptions {documents:choices,..Default::default()},&names,&source_users).unwrap();
        std::fs::write(directory.join(format!("{mode}-preview.json")),serde_json::to_vec_pretty(&p).unwrap()).unwrap();
        let docs=book::documents(&c); std::fs::write(directory.join("pc-documents.json"),serde_json::to_vec(&docs).unwrap()).unwrap();
        assert_eq!(p.hits.len(),0,"name gate hit count only");
        if mode != "one-rule" { save_file(&directory.join(format!("agent-design-{mode}.html")),&p,Path::new(&c.home),&[]).unwrap(); }
        println!("PC_EXPORT mode={mode} hits={} documents={} bytes={}",p.hits.len(),p.document_count,p.bytes);
    }
    let mut blocked=c.clone(); blocked.documents.insert(chosen[0].clone(),json!({"body":"FICTIONAL_PERSON"}));
    let p=book::prepare(&blocked,&ExportOptions {documents:vec![whole(&chosen[0])],..Default::default()},&["fictional_person".into()],&source_users).unwrap();
    assert!(!p.hits.is_empty());
    let path=directory.join("blocked-must-not-exist.html");
    assert_eq!(save_file(&path,&p,Path::new(&c.home),&[]).unwrap_err(),"exportNamesFound"); assert!(!path.exists());
    std::fs::write(directory.join("blocked-preview.json"),serde_json::to_vec_pretty(&p).unwrap()).unwrap();
    println!("PC_EXPORT blocked hits={} saved=false",p.hits.len());
}

#[test]
fn v04_export_masks_nested_and_shaped_secrets_using_stage_c_rules() {
    let mut c = fixture();
    c.documents.insert("rule".into(), json!({"body": "# Rule\nauth:\n  value: CANARY_SECRET_7F3A\nPublic step\nBearer CANARY_SECRET_7F3A\n"}));
    let p = prepare(&c, vec![whole("rule")]);
    assert!(!p.html.contains("CANARY_SECRET_7F3A"));
    assert!(p.html.contains("Public step"));
    assert!(!serde_json::to_string(&p).unwrap().contains("CANARY_SECRET_7F3A"));
    assert!(p.html.contains(super::super::redaction::PLACEHOLDER));
}
#[test]
fn v04_export_uses_plain_evidence_and_omits_unmeasured_size_fields() {
    let mut c = fixture(); c.items[3].read_timing = "outside".into();
    c.items[3].size = Size { chars: None, lines: None, bytes: Some(2048) };
    let p = prepare(&c, vec![]);
    assert!(p.html.contains("会話には入らない（アプリが使う設定）"));
    assert!(p.html.contains("設定から分かる"));
    assert!(p.html.contains("大きさ: 2.00 KB"));
    assert!(!p.html.contains("不明 字")); assert!(!p.html.contains("不明 行"));
    assert!(p.html.contains("今回の読取・実行の回数は未収集"));
}

#[test]
fn v04_export_rechecks_availability_and_rebuilds_selected_current_body() {
    let dir = tempfile::tempdir().unwrap(); let home = safe::canonical(dir.path());
    let path = home.join(".claude/rules/current.md"); std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut c = fixture(); c.home = home.to_string_lossy().into(); c.cwd = c.home.clone(); c.work_folder = c.home.clone(); c.services[0].root=home.join(".claude").to_string_lossy().into();
    c.items[0].path = Some(path.to_string_lossy().into()); c.documents.remove("rule");
    let missing = recheck(&home, &c, "rule").unwrap(); assert!(!missing.available); assert_eq!(missing.reason.as_deref(), Some("fileMissing"));
    std::fs::write(&path, "# Current\nNew public line\ntoken = CANARY_SECRET_7F3A\n").unwrap();
    let ready = recheck(&home, &c, "rule").unwrap(); assert!(ready.available); assert!(ready.reason.is_none());
    let options = ExportOptions { documents: vec![whole("rule")], ..Default::default() };
    let first = preview(&home, c.clone(), &options).unwrap(); assert!(first.html.contains("New public line")); assert!(!first.html.contains("CANARY_SECRET_7F3A"));
    std::fs::write(&path, "# Current\nChanged public line\n").unwrap();
    let second = preview(&home, c.clone(), &options).unwrap(); assert_ne!(first.fingerprint, second.fingerprint);
    std::fs::remove_file(&path).unwrap(); assert!(preview(&home, c.clone(), &options).is_err());
    std::fs::write(&path, [0, 255]).unwrap(); let binary = recheck(&home, &c, "rule").unwrap(); assert!(!binary.available); assert_eq!(binary.reason.as_deref(), Some("unsupportedEncoding"));
    std::fs::write(&path, [0, 1]).unwrap(); let binary = recheck(&home, &c, "rule").unwrap(); assert!(!binary.available); assert_eq!(binary.reason.as_deref(), Some("binaryFile"));
    std::fs::write(&path, "a".repeat(safe::DOCUMENT_LIMIT as usize + 1)).unwrap(); let large = recheck(&home, &c, "rule").unwrap(); assert!(!large.available); assert_eq!(large.reason.as_deref(), Some("truncated"));
}
