use super::{catalog, detail, files, frontmatter};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/skills_home");
    let pocket = std::env::var_os("MYCMUX_POCKET_SOURCE");
    if let Some(pocket) = pocket {
        let output = std::process::Command::new("python")
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
        let output=std::process::Command::new("python").arg("-X").arg("utf8").arg("-c").arg("import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from prepare_home import prepare; prepare(Path(sys.argv[2]))").arg(&fixture).arg(&home).output().unwrap();
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
