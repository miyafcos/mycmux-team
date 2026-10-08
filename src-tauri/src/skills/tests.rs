use super::{catalog, detail, files, frontmatter};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = if cfg!(windows) { temp.path().to_owned() } else { fs::canonicalize(temp.path()).unwrap() };
    let home = root.join("home");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/skills_home");
    let pocket = std::env::var_os("MYCMUX_POCKET_SOURCE");
    if let Some(pocket) = pocket {
        let output = std::process::Command::new(if cfg!(windows) { "python" } else { "python3" })
            .arg("-X")
            .arg("utf8")
            .arg(fixture.join("prepare_home.py"))
            .arg("--home")
            .arg(&home)
            .arg("--pocket")
            .arg(pocket)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    } else {
        let output=std::process::Command::new(if cfg!(windows) { "python" } else { "python3" }).arg("-X").arg("utf8").arg("-c").arg("import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from prepare_home import prepare; prepare(Path(sys.argv[2]))").arg(&fixture).arg(&home).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    (temp, home)
}
fn collect(home: &Path) -> Value {
    catalog::collect(
        home,
        &home.join(".mycmux/skills"),
        catalog::read_json(&home.join("defaults.json")),
    )
}

#[test]
fn catalogue_layers_aliases_kinds_and_usage() {
    let (_temp, home) = fixture();
    let shelf = collect(&home);
    let row = shelf["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "sample-review")
        .unwrap();
    assert_eq!(row["label"], "Manual review");
    assert_eq!(row["category"], "gate");
    assert_eq!(row["curation"], "manual");
    assert_eq!(row["agents"], json!(["claude", "codex"]));
    assert_eq!(row["usageCount"], 7);
    assert_eq!(row["aliases"], json!(["old-name"]));
    assert_eq!(shelf["hiddenCount"], 1);
    assert!(shelf["skills"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == "sample:plugin-review" && s["docPath"].is_string()));
    assert!(shelf["skills"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == "demo-tool" && s["kind"] == "plugin"));
    fs::rename(
        home.join(".mycmux/skills/shelf.json"),
        home.join(".mycmux/skills/shelf.saved.json"),
    )
    .unwrap();
    let shelf = collect(&home);
    let row = shelf["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "sample-review")
        .unwrap();
    assert_eq!(row["label"], "Author label");
    assert_eq!(row["curation"], "skill");
}
#[test]
fn python_catalogue_and_share_plan_match() {
    let (_temp, home) = fixture();
    let actual = collect(&home);
    let plan = files::plan(
        &home.join(".claude/skills/sample-review/SKILL.md"),
        "sample-review",
    )
    .unwrap();
    let expected = catalog::read_json(&home.join("python-expected.json"));
    if std::env::var_os("MYCMUX_POCKET_SOURCE").is_some() {
        let fields = [
            "id",
            "label",
            "line",
            "symbol",
            "category",
            "kind",
            "agents",
            "curation",
            "docPath",
            "aliases",
            "calls",
            "usage",
            "usageCount",
            "lastUsedAt",
            "plugin",
            "description",
            "isNew",
        ];
        let normalize = |shelf: &Value| {
            shelf["skills"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| {
                    Value::Object(
                        fields
                            .iter()
                            .map(|k| ((*k).to_owned(), s[*k].clone()))
                            .collect(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(normalize(&actual), normalize(&expected["catalog"]));
        assert_eq!(actual["categories"], expected["catalog"]["categories"]);
        let rows: Vec<_> = plan["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| json!({"path":r["path"],"reason":r["reason"]}))
            .collect();
        assert_eq!(json!(rows), expected["files"]);
        assert_eq!(plan["selected"], expected["selected"]);
    } else {
        assert_eq!(
            plan["selected"],
            json!([
                "assets/example.txt",
                "reference/notes.md",
                "scripts/check.py",
                "SKILL.md"
            ])
        );
    }
}
#[test]
fn location_wrappers_copies_implicit_and_broken_junction() {
    let (_temp, home) = fixture();
    let places = detail::locations(&home, "sample-review");
    assert_eq!(places["duplicateCodex"], true);
    let plugin_duplicate = home.join(".codex/skills/demo-tool");
    fs::create_dir_all(&plugin_duplicate).unwrap();
    fs::write(
        plugin_duplicate.join("SKILL.md"),
        "---\nname: demo-tool\ndescription: A duplicate plugin name.\n---\n# Demo\n",
    )
    .unwrap();
    assert_eq!(detail::locations(&home, "demo-tool")["codexCount"], 2);
    let rows = places["items"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().any(|r| r["relation"] == "wrapper"
        && r["targetExists"] == true
        && r["descriptionSame"] == false
        && r["allowImplicitInvocation"] == false));
    assert!(rows
        .iter()
        .any(|r| r["relation"] == "copy" && r["sameContent"] == false));
    if catalog::read_json(&home.join("junction-result.json"))["created"] == true {
        assert_eq!(
            detail::locations(&home, "broken-demo")["items"][0]["relation"],
            "brokenJunction"
        );
    }
}
#[test]
fn zip_names_selection_limits_and_secret_denial() {
    let (_temp, home) = fixture();
    let path = home.join(".claude/skills/sample-review/SKILL.md");
    let plan = files::plan(&path, "sample-review").unwrap();
    let selected: Vec<String> = plan["selected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let destination = home.join("sample.zip");
    files::make_zip(&path, "sample-review", &selected, &destination).unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(&destination).unwrap()).unwrap();
    assert_eq!(zip.len(), selected.len());
    for index in 0..zip.len() {
        assert!(zip
            .by_index(index)
            .unwrap()
            .name()
            .starts_with("sample-review/"));
    }
    assert!(files::make_zip(&path, "sample-review", &selected, &destination).is_err());
    assert!(files::preview(&path, "sample-review", ".env").is_err());
    assert!(files::preview(&path, "sample-review", "private.env").is_err());
    assert!(files::preview(&path, "sample-review", "../SKILL.md").is_err());
    assert!(files::selected(&plan, &["scripts/check.py".to_owned()]).is_err());
    let mut large = plan.clone();
    large["files"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|r| r["path"] == selected[0])
        .unwrap()["size"] = json!(files::LIMIT_BYTES + 1);
    assert!(files::selected(&large, &selected).is_err());
    assert_eq!(
        files::preview(&path, "sample-review", "large.txt").unwrap()["kind"],
        "external"
    );
    let names: Vec<_> = (0..=files::LIMIT_FILES)
        .map(|i| format!("file-{i}.txt"))
        .collect();
    let count_plan = json!({"files": names.iter().map(|name|json!({"path":name,"size":1,"reason":null})).collect::<Vec<_>>()});
    assert!(files::selected(&count_plan, &names).is_err());
}
#[test]
fn single_command_share_has_only_one_document() {
    let (_temp, home) = fixture();
    let plan = files::plan(
        &home.join(".claude/commands/sample-report.md"),
        "sample-report",
    )
    .unwrap();
    assert_eq!(plan["single"], true);
    assert_eq!(plan["files"].as_array().unwrap().len(), 1);
}
#[test]
fn frontmatter_live_optional_comparison_and_export() {
    if let Some(input) = std::env::var_os("SKILLS_FRONTMATTER_INPUT") {
        let input = catalog::read_json(Path::new(&input));
        let mut mismatches = Vec::new();
        let mut checked = 0;
        for row in input.as_array().unwrap() {
            let (value, _) = frontmatter::split(row["source"].as_str().unwrap_or(""));
            let mut got = json!({});
            for field in ["name", "description", "allowed-tools"] {
                got[field] = value[field].clone();
            }
            for field in ["triggers", "exclusions", "pocket"] {
                got[field] = value["metadata"][field].clone();
            }
            checked += 1;
            if got != row["expected"] {
                mismatches
                    .push(json!({"path":row["path"],"expected":row["expected"],"actual":got}));
            }
        }
        if let Some(output) = std::env::var_os("SKILLS_FRONTMATTER_OUTPUT") {
            fs::write(output,serde_json::to_vec_pretty(&json!({"checked":checked,"matches":checked-mismatches.len(),"mismatches":mismatches})).unwrap()).unwrap();
        }
        assert!(
            mismatches.is_empty(),
            "frontmatter differences: {}",
            mismatches.len()
        );
    }
    if let Some(output) = std::env::var_os("SKILLS_LIVE_OUTPUT") {
        let home = dirs::home_dir().unwrap();
        let data = catalog::collect(
            &home,
            &home.join(".mycmux/skills"),
            serde_json::from_str(catalog::DEFAULTS).unwrap(),
        );
        fs::write(output, serde_json::to_vec_pretty(&data).unwrap()).unwrap();
    }
}

#[test]
fn usage_and_manual_keys_are_case_insensitive() {
    let (_temp, home) = fixture();
    fs::write(home.join(".claude.json"), json!({
        "skillUsage":{"SAMPLE-REVIEW":{"usageCount":"9"},"OLD-NAME":{"usageCount":2}}
    }).to_string()).unwrap();
    let shared = home.join(".mycmux/skills");
    let mut manual = catalog::read_json(&shared.join("shelf.json"));
    manual["skills"] = json!({"SaMpLe-ReViEw":{"category":"code","label":"Case sample","symbol":null}});
    fs::write(shared.join("shelf.json"), manual.to_string()).unwrap();
    let shelf = collect(&home);
    let row = shelf["skills"].as_array().unwrap().iter().find(|r|r["id"]=="sample-review").unwrap();
    assert_eq!(row["usage"], json!({"claude":11,"codex":1}));
    assert_eq!(row["usageCount"], 12);
    assert_eq!(row["category"], "code");
    assert_eq!(row["label"], "Case sample");
    assert_eq!(row["symbol"], Value::Null);
    assert_eq!(row["curation"], "manual");
}

#[test]
fn codex_usage_includes_the_ninety_day_boundary_once_per_session() {
    let temp = tempfile::tempdir().unwrap();
    let now_ms = 1_800_000_000_000_i64;
    let cutoff_ms = now_ms - 90 * 86_400_000;
    fs::write(temp.path().join("usage_codex.json"), json!({
        "boundary":{"mtimeNs":cutoff_ms*1_000_000,"skills":["sample","sample"],"last":1200},
        "recent":{"mtimeNs":(cutoff_ms+1)*1_000_000,"skills":["sample"],"last":1100},
        "expired":{"mtimeNs":(cutoff_ms-1)*1_000_000,"skills":["sample"],"last":9999},
        "missing-time":{"skills":["sample"],"last":9999}
    }).to_string()).unwrap();
    let (usage, recorded) = catalog::usage_at(temp.path(), now_ms as f64);
    assert!(recorded);
    assert_eq!(usage, json!({"sample":{"count":2,"last":1200.0}}));
    assert!(!catalog::usage(&temp.path().join("absent")).1);
}

#[test]
fn refreshing_rebuilds_memory_and_disk_from_current_shared_inputs() {
    let (_temp, home) = fixture();
    let shared = home.join(".mycmux/skills");
    let snapshot = std::sync::Mutex::new(None);
    let before = super::refresh_snapshot(&home, &shared, &snapshot).unwrap();
    let row = |shelf: &Value| shelf["skills"].as_array().unwrap().iter()
        .find(|r|r["id"]=="sample-review").unwrap().clone();
    assert_eq!(row(&before)["usageCount"], 7);
    fs::write(home.join(".claude.json"), json!({"skillUsage":{"sample-review":{"usageCount":20}}}).to_string()).unwrap();
    let mut manual = catalog::read_json(&shared.join("shelf.json"));
    manual["skills"]["sample-review"]["category"] = json!("code");
    fs::write(shared.join("shelf.json"), manual.to_string()).unwrap();
    let after = super::refresh_snapshot(&home, &shared, &snapshot).unwrap();
    assert_eq!(row(&after)["usageCount"], 21);
    assert_eq!(row(&after)["category"], "code");
    assert_eq!(after["schemaVersion"], 1);
    assert_eq!(*snapshot.lock().unwrap(), Some(after.clone()));
    assert_eq!(catalog::read_json(&shared.join("cache.json")), after);
    assert_ne!(row(&before), row(&after));
    let blocked = home.join("blocked-cache-directory");
    fs::write(&blocked, "a file cannot be a cache directory").unwrap();
    assert!(super::refresh_snapshot(&home, &blocked, &snapshot).is_err());
    assert_eq!(*snapshot.lock().unwrap(), Some(after));
}
