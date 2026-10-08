use super::*;
use std::collections::BTreeSet;

#[test]
fn v04_initial_flow_excludes_conditional_and_shadowed_instructions() {
    let f = Fixture::new("both");
    let c = f.catalog();
    let flow = c.reading_flows.iter().find(|flow| flow.service == "claude").unwrap();
    let initial = flow.steps.iter().find(|step| step.id == "instructions").unwrap();
    assert!(!initial.item_ids.is_empty());
    assert!(initial.item_ids.iter().all(|id| c.items.iter().any(|item| &item.id == id && item.active && item.read_timing == "always")));
    let conditional = flow.steps.iter().find(|step| step.id == "conditional").unwrap();
    assert!(!conditional.item_ids.is_empty());
    assert!(initial.item_ids.iter().all(|id| !conditional.item_ids.contains(id)));
    assert_eq!(flow.steps.len(), 12);
}

#[test]
#[ignore = "manual read-only acceptance export; requires an explicit evidence directory"]
fn export_acceptance_catalog() {
    let output = PathBuf::from(
        std::env::var_os("MYCMUX_AGENT_DESIGN_EVIDENCE_DIR").expect("explicit evidence directory"),
    );
    assert!(output.is_absolute() && output.is_dir());
    let prefix =
        std::env::var("MYCMUX_AGENT_DESIGN_EVIDENCE_PREFIX").expect("explicit evidence prefix");
    assert!(
        !prefix.is_empty()
            && prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
    );
    let emit = |suffix: &str, value: &Catalog| {
        let bytes = serde_json::to_vec(value).unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(!text.contains("CANARY_SECRET_7F3A") && !text.contains("CANARY_BODY_9C1D"));
        let path = output.join(format!("{prefix}-{suffix}.json"));
        assert!(!path.exists(), "preserve acceptance evidence");
        fs::write(&path, &bytes).unwrap();
        assert_eq!(fs::read(path).unwrap(), bytes);
    };
    let emit_skills = |suffix: &str, h: &Path, c: &Catalog| {
        let bytes = serde_json::to_vec(&skill_read::catalog(h, c)).unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(!text.contains("CANARY_SECRET_7F3A") && !text.contains("CANARY_BODY_9C1D"));
        let path = output.join(format!("{prefix}-{suffix}.json"));
        assert!(!path.exists(), "preserve acceptance evidence");
        fs::write(&path, &bytes).unwrap();
        assert_eq!(fs::read(path).unwrap(), bytes);
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let actual = runtime.block_on(agent_design_refresh(None)).unwrap();
    let h = home().unwrap();
    assert_eq!(
        fs::read(state_dir(&h).join("catalog.json")).unwrap(),
        serde_json::to_vec(&actual).unwrap()
    );
    emit("api", &actual);
    emit("catalog", &actual);
    emit_skills("skills", &h, &actual);
    if let Some(folder) = std::env::var_os("MYCMUX_AGENT_DESIGN_TEMP_CWD") {
        let folder = PathBuf::from(folder);
        assert!(folder.is_absolute() && folder.is_dir());
        let temporary = runtime
            .block_on(agent_design_refresh(Some(folder.to_string_lossy().into())))
            .unwrap();
        assert_eq!(
            fs::read(state_dir(&h).join("catalog.json")).unwrap(),
            serde_json::to_vec(&temporary).unwrap()
        );
        emit("api-temp", &temporary);
        emit("catalog-temp", &temporary);
        let _guard = WRITE_LOCK.lock().unwrap();
        save(&h, &actual).unwrap();
    }
    for variant in ["claude_only", "codex_only", "both", "empty"] {
        let f = Fixture::new(variant);
        let c = f.catalog();
        emit(&format!("synthetic-{}", variant.replace('_', "-")), &c);
        emit_skills(
            &format!(
                "skills-synthetic-{}",
                match variant {
                    "claude_only" => "claude",
                    "codex_only" => "codex",
                    "both" => "both",
                    _ => "empty",
                }
            ),
            f.home(),
            &c,
        );
    }
    println!(
        "acceptance catalog exported; refresh_ms={:.3}; items={}; closed={}",
        actual.refresh_ms,
        actual.items.len(),
        actual.closed_count
    );
}
use std::fs;
use tempfile::{tempdir, TempDir};

struct Fixture {
    _directory: TempDir,
    home: PathBuf,
}
impl Fixture {
    fn new(kind: &str) -> Self {
        let directory = tempdir().unwrap();
        // Match the generator's resolved cwd and avoid macOS's /var alias.
        // Keep state-target symlink rejection unchanged.
        let home = safe::canonical(directory.path());
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/agent_home/prepare_home.py");
        let result = std::process::Command::new(if cfg!(windows) { "python" } else { "python3" })
            .arg(script)
            .arg(&home)
            .args(["--variant", kind])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "synthetic fixture generator failed"
        );
        Self {
            _directory: directory,
            home,
        }
    }
    fn home(&self) -> &Path {
        &self.home
    }
    fn catalog(&self) -> Catalog {
        collect(
            self.home(),
            self.home(),
            &self.home().join(".codex"),
            &self.home().join(".hermes"),
            &scheduled::Jobs::default(),
            (None, None),
        )
    }
}
fn service<'a>(c: &'a Catalog, id: &str) -> &'a Service {
    c.services.iter().find(|s| s.id == id).unwrap()
}
fn has_path(item: &Item, path: &Path) -> bool {
    item.path
        .as_deref()
        .is_some_and(|p| safe::same_path(Path::new(p), path))
}
fn write(home: &Path, path: &str, text: &str) {
    let p = home.join(path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}
#[test]
fn agent_home_four_variants_and_hermes_only() {
    for kind in ["claude_only", "codex_only", "both", "empty"] {
        let f = Fixture::new(kind);
        let c = f.catalog();
        assert_eq!(c.services.len(), 3);
        assert_eq!(
            service(&c, "claude").state == "present",
            ["claude_only", "both"].contains(&kind)
        );
        assert_eq!(
            service(&c, "codex").state == "present",
            ["codex_only", "both"].contains(&kind)
        );
        if kind == "empty" {
            assert!(c.findings.is_empty());
            assert_eq!(service(&c, "claude").context.total, None);
        }
    }
    let f = Fixture::new("empty");
    write(
        f.home(),
        ".hermes/skills/example/SKILL.md",
        "synthetic skill",
    );
    write(f.home(), ".hermes/config.yaml", "configuration is not read");
    let c = f.catalog();
    assert_eq!(service(&c, "hermes").stats["skillsOwn"], Some(1));
    assert_eq!(service(&c, "hermes").state, "present");
}
#[test]
fn claude_reader_counts_rules_hooks_commands_mcp_and_memory_caps() {
    let f = Fixture::new("claude_only");
    let c = f.catalog();
    let a = service(&c, "claude");
    assert_eq!(a.stats["rules"], Some(2));
    assert_eq!(a.stats["rulesAlways"], Some(1));
    assert_eq!(a.stats["rulesConditional"], Some(1));
    assert_eq!(a.stats["allow"], Some(2));
    assert_eq!(a.stats["allowLocal"], Some(1));
    assert_eq!(a.stats["envCount"], Some(2));
    assert_eq!(a.stats["mcpUser"], Some(1));
    assert_eq!(a.stats["mcpProject"], Some(1));
    assert_eq!(a.stats["commands"], Some(1));
    assert_eq!(a.stats["hookEvents"], Some(2));
    assert_eq!(a.stats["hookHandlers"], Some(2));
    assert_eq!(a.stats["tokensFiles"], Some(2));
    assert_eq!(a.stats["memoryIndexLines"], Some(210));
    let full = fs::read_to_string(
        f.home()
            .join(".claude/projects")
            .join(safe::project_key(f.home()))
            .join("memory/MEMORY.md"),
    )
    .unwrap();
    let expected = full
        .split_inclusive('\n')
        .take(200)
        .collect::<String>()
        .chars()
        .take(25000)
        .count() as u64;
    assert_eq!(a.context.memory, Some(expected));
    assert!(expected < a.stats["memoryIndexChars"].unwrap());
    assert_eq!(a.session.listing.count, Some(5));
    assert_eq!(a.context.startup, Some("CANARY_SECRET_7F3A".len() as u64));
    assert_eq!(
        a.session
            .listing
            .groups
            .iter()
            .map(|g| g.count)
            .sum::<u64>(),
        5
    );
}
#[test]
fn codex_reader_safe_toml_fields_listing_and_disabled_plugins() {
    let f = Fixture::new("codex_only");
    let c = f.catalog();
    let a = service(&c, "codex");
    assert_eq!(a.stats["mcp"], Some(1));
    assert_eq!(a.stats["mcpDisabled"], Some(1));
    assert_eq!(a.stats["mcpCommented"], Some(1));
    assert_eq!(a.stats["plugins"], Some(2));
    assert_eq!(a.stats["pluginsEnabled"], Some(1));
    assert_eq!(a.stats["projects"], Some(1));
    assert_eq!(a.session.listing.count, Some(4));
    assert_eq!(a.session.listing.disabled_counts["sample-plugin"], 2);
    assert_eq!(
        a.session
            .listing
            .groups
            .iter()
            .find(|g| g.kind == "system")
            .unwrap()
            .count,
        1
    );
    assert!(a.context.instructions.unwrap() > 0);
    assert!(a.context.memory.unwrap() > 0);
    assert_eq!(a.context.startup, None);
    assert_eq!(
        a.context.total,
        Some(
            a.context.instructions.unwrap()
                + a.context.memory.unwrap()
                + a.context.listing.unwrap()
        )
    );
    assert!(a.settings.iter().any(|f| f.key == "unsupported"));
}
#[test]
fn secret_canary_never_enters_catalog_api_cache_or_opened_private_files() {
    let f = Fixture::new("both");
    safe::OPENED.with(|p| p.borrow_mut().clear());
    let c = f.catalog();
    let body = serde_json::to_string(&c).unwrap();
    assert!(
        !body.contains("CANARY_SECRET_7F3A"),
        "secret canary in catalogue"
    );
    assert!(
        !body.contains("CANARY_BODY_9C1D"),
        "conversation body in catalogue"
    );
    save(f.home(), &c).unwrap();
    let cached = cached(f.home(), f.home()).unwrap();
    assert!(
        !serde_json::to_string(&cached)
            .unwrap()
            .contains("CANARY_SECRET_7F3A"),
        "secret canary in cache API"
    );
    let text = fs::read_to_string(state_dir(f.home()).join("cache.json")).unwrap();
    assert!(
        !text.contains("CANARY_SECRET_7F3A"),
        "secret canary in cache file"
    );
    assert!(
        !text.contains("CANARY_BODY_9C1D"),
        "body canary in cache file"
    );
    assert!(!body.contains("secret-name.txt"));
    assert!(!body.contains("private-file.dat"));
    safe::OPENED.with(|paths| {
        for path in paths.borrow().iter() {
            assert!(!safe::private(path), "private file was opened");
            assert_ne!(
                safe::basename(path),
                "default.rules",
                "execution rules content was opened"
            );
            assert_ne!(safe::basename(path), "body.md", "memory body was opened");
            assert_ne!(safe::basename(path), "note.md", "memory body was opened");
        }
    });
}
#[test]
fn claude_stops_before_first_assistant_body_and_keeps_only_initial_attachment() {
    let f = Fixture::new("claude_only");
    let c = f.catalog();
    let a = service(&c, "claude");
    assert_eq!(a.session.stopped_at, "firstAssistant");
    assert_eq!(a.session.lines_read, 2);
    let path = records::latest_claude(&f.home().join(".claude"), f.home()).unwrap();
    let data = fs::read(&path).unwrap();
    let marker = data
        .windows("CANARY_BODY_9C1D".len())
        .position(|w| w == b"CANARY_BODY_9C1D")
        .unwrap();
    assert!(
        a.session.bytes_consumed < marker as u64,
        "assistant body bytes consumed"
    );
}
#[test]
fn codex_stops_before_world_state_and_first_request_body() {
    let f = Fixture::new("codex_only");
    let path = records::latest_codex(&f.home().join(".codex"), f.home()).unwrap();
    let s = records::codex(&path, &BTreeMap::new());
    assert_eq!(s.stopped_at, "worldState");
    assert_eq!(s.lines_read, 5);
    let data = fs::read_to_string(&path).unwrap();
    assert!(s.bytes_consumed < data.find("CANARY_BODY_9C1D").unwrap() as u64);
    let without_world = data
        .lines()
        .filter(|l| !l.contains("\"world_state\""))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(&path, &without_world).unwrap();
    let s = records::codex(&path, &BTreeMap::new());
    assert_eq!(s.stopped_at, "firstRequest");
    assert!(
        s.bytes_consumed < without_world.find("CANARY_BODY_9C1D").unwrap() as u64,
        "first request body bytes consumed"
    );
}
#[test]
fn codex_meta_matching_and_latest_cwd_selection_only_read_headers() {
    let f = Fixture::new("codex_only");
    let target = records::latest_codex(&f.home().join(".codex"), f.home()).unwrap();
    assert_eq!(
        records::meta_cwd(&target).map(PathBuf::from),
        Some(f.home().to_owned())
    );
    let other = f.home().join("project");
    fs::create_dir(&other).unwrap();
    assert!(records::latest_codex(&f.home().join(".codex"), &other).is_none());
}
#[test]
fn override_is_active_agents_is_shadowed_and_relationship_is_product_rule() {
    let f = Fixture::new("both");
    let c = f.catalog();
    assert!(c.items.iter().any(|i| i.kind == "override" && i.active));
    assert!(c
        .items
        .iter()
        .any(|i| i.kind == "shadowedInstruction" && !i.active && i.read_timing == "outside"));
    assert!(c
        .links
        .iter()
        .any(|l| l.relation == "shadows" && l.evidence == "product"));
    assert!(c.findings.iter().any(
        |f| f.kind == "shadowedAgents" && f.evidence.iter().any(|e| e.rule == "declaredWriter")
    ));
}
#[test]
fn rule_reference_order_and_declarative_path_scene() {
    let f = Fixture::new("both");
    let c = f.catalog();
    let names: Vec<_> = c
        .links
        .iter()
        .filter(|l| l.relation == "references")
        .map(|l| l.to.as_str())
        .collect();
    assert_eq!(names, ["references/guide.md", "scripts/hook.py"]);
    assert_eq!(
        scene(&c, "src/nested/example.tsx")["itemIds"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        scene(&c, "docs/example.md")["itemIds"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        scene(&c, "src/nested/example.tsx")["evidence"],
        "declaration"
    );
}
#[test]
fn rule_links_keep_whole_nested_paths_and_all_script_extensions() {
    let f = Fixture::new("claude_only");
    write(
        f.home(),
        ".claude/rules/always.md",
        "skills/references/design.md then scripts/run.sh then references/guide.\n",
    );
    let c = f.catalog();
    let links: Vec<_> = c
        .links
        .iter()
        .filter(|l| l.relation == "references")
        .map(|l| l.to.as_str())
        .collect();
    assert_eq!(
        links,
        [
            "skills/references/design.md",
            "scripts/run.sh",
            "references/guide"
        ]
    );
}
#[test]
fn inspection_six_categories_and_broken_entry() {
    let f = Fixture::new("both");
    let c = f.catalog();
    for kind in [
        "disabledPlugins",
        "unusedListing",
        "implicitHidden",
        "shadowedAgents",
        "memoryLimit",
        "duplicate",
    ] {
        assert!(
            c.findings.iter().any(|f| f.kind == kind),
            "inspection category missing"
        );
    }
    let f = Fixture::new("codex_only");
    assert!(f
        .catalog()
        .findings
        .iter()
        .any(|f| f.kind == "brokenTarget"));
}
#[test]
fn closed_reason_date_and_next_refresh_preserve_intent() {
    let f = Fixture::new("both");
    let mut c = f.catalog();
    let count = c.findings.len();
    inspect::save_close(
        &state_dir(f.home()),
        &mut c,
        "codex:implicitHidden",
        "Intentional explicit invocation",
    )
    .unwrap();
    assert_eq!(c.findings.len(), count - 1);
    assert_eq!(c.closed_count, 1);
    let closed: Closed =
        serde_json::from_str(&fs::read_to_string(state_dir(f.home()).join("closed.json")).unwrap())
            .unwrap();
    assert_eq!(closed.closed[0].reason, "Intentional explicit invocation");
    assert!(chrono::DateTime::parse_from_rfc3339(&closed.closed[0].date).is_ok());
    assert_eq!(closed.closed[0].closed_from, "pc");
    assert_eq!(closed.revision, 1);
    assert!(!f
        .catalog()
        .findings
        .iter()
        .any(|f| f.kind == "implicitHidden"));
    assert!(inspect::save_close(&state_dir(f.home()), &mut c, "missing", "").is_err());
}
#[test]
fn malformed_closed_is_preserved_without_overwrite() {
    let f = Fixture::new("both");
    write(f.home(), ".mycmux/agent_design/closed.json", "not-json");
    let mut c = f.catalog();
    assert!(c.warnings.iter().any(|s| s == "closedUnsupported"));
    assert!(inspect::save_close(
        &state_dir(f.home()),
        &mut c,
        "codex:implicitHidden",
        "example"
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(state_dir(f.home()).join("closed.json")).unwrap(),
        "not-json"
    );
}
#[test]
fn allowed_document_and_forged_private_document() {
    let f = Fixture::new("both");
    let mut c = f.catalog();
    let id = c
        .items
        .iter()
        .find(|i| i.kind == "instruction" && i.service == "claude")
        .unwrap()
        .id
        .clone();
    assert!(document(f.home(), f.home(), &c, &id).unwrap()["body"]
        .as_str()
        .unwrap()
        .contains("Instructions"));
    let item = c.items.iter_mut().find(|i| i.id == id).unwrap();
    item.path = Some(f.home().join(".codex/auth.json").to_string_lossy().into());
    item.fields.clear();
    assert!(document(f.home(), f.home(), &c, &id).is_err());
}
#[test]
fn cache_is_scoped_by_working_folder_and_schema() {
    let f = Fixture::new("both");
    let c = f.catalog();
    save(f.home(), &c).unwrap();
    assert!(cached(f.home(), f.home()).is_some());
    let project = f.home().join("other");
    fs::create_dir(&project).unwrap();
    assert!(cached(f.home(), &project).is_none());
    write(
        f.home(),
        ".mycmux/agent_design/cache.json",
        "{\"schemaVersion\":999,\"contexts\":[]}",
    );
    assert!(cached(f.home(), f.home()).is_none());
}
#[test]
fn scheduler_english_japanese_duplicate_and_unknown_enabled_column() {
    let cl = Path::new("C:/synthetic/.claude");
    let cx = Path::new("C:/synthetic/.codex");
    let text="\"TaskName\",\"Task To Run\",\"Scheduled Task State\"\n\"a\",\"python C:/synthetic/.claude/scripts/task.py --key hidden\",\"Enabled\"\n\"a\",\"python C:/synthetic/.claude/scripts/task.py\",\"Enabled\"\n\"b\",\"python C:/synthetic/.claude/scripts/off.py\",\"Disabled\"\n\"c\",\"python C:/synthetic/.codex/scripts/task.py\",\"Enabled\"\n";
    let j = scheduled::parse_windows(text, cl, cx);
    assert_eq!(j.claude, Some(2));
    assert_eq!(j.claude_enabled, Some(1));
    assert_eq!(j.codex, Some(1));
    assert_eq!(j.codex_enabled, Some(1));
    let localized = text
        .replace("TaskName", "タスク名")
        .replace("Task To Run", "実行するタスク")
        .replace("Scheduled Task State", "スケジュールされたタスクの状態")
        .replace("Enabled", "有効")
        .replace("Disabled", "無効");
    assert_eq!(
        scheduled::parse_windows(&localized, cl, cx).claude_enabled,
        Some(1)
    );
    let j = scheduled::parse_windows(
        "\"TaskName\",\"Task To Run\"\n\"a\",\"C:/synthetic/.claude/scripts/task.py\"\n",
        cl,
        cx,
    );
    assert_eq!(j.claude, Some(1));
    assert_eq!(j.claude_enabled, None);
    assert_eq!(scheduled::parse_windows("unknown", cl, cx).claude, None);
}
#[test]
fn scheduler_launchagents_counts_programarguments_without_executing() {
    let a="<plist><dict><key>ProgramArguments</key><array><string>python</string><string>/synthetic/.claude/scripts/job.py</string></array></dict></plist>";
    let b = a
        .replace(".claude", ".codex")
        .replace("</dict>", "<key>Disabled</key><true/></dict>");
    let j = scheduled::parse_mac(
        &[a.into(), b],
        Path::new("/synthetic/.claude"),
        Path::new("/synthetic/.codex"),
    );
    assert_eq!(j.claude, Some(1));
    assert_eq!(j.claude_enabled, Some(1));
    assert_eq!(j.codex, Some(1));
    assert_eq!(j.codex_enabled, Some(0));
}
#[test]
fn unsupported_json_toml_and_missing_log_are_unknown_not_zero() {
    let f = Fixture::new("both");
    write(f.home(), ".claude/settings.json", "invalid");
    write(f.home(), ".codex/config.toml", "[invalid");
    let c = f.catalog();
    assert_eq!(service(&c, "claude").stats["hookHandlers"], None);
    assert!(
        c.items
            .iter()
            .filter(|i| i.kind == "settings" && ["claude", "codex"].contains(&i.service.as_str()))
            .all(|i| i.status == "unknown"),
        "settings statuses: {:?}",
        c.items
            .iter()
            .filter(|i| i.kind == "settings" && ["claude", "codex"].contains(&i.service.as_str()))
            .map(|i| (&i.path, &i.status))
            .collect::<Vec<_>>()
    );
    let f = Fixture::new("empty");
    assert_eq!(service(&f.catalog(), "codex").context.instructions, None);
}
#[test]
fn skill_counts_are_metadata_based_and_private_names_stay_hidden() {
    let f = Fixture::new("empty");
    write(
        f.home(),
        ".codex/skills/token-hidden/SKILL.md",
        "CANARY_SECRET_7F3A",
    );
    write(f.home(), ".codex/skills/unreadable/SKILL.md", "");
    fs::write(f.home().join(".codex/skills/unreadable/SKILL.md"), [255]).unwrap();
    safe::OPENED.with(|p| p.borrow_mut().clear());
    let c = f.catalog();
    assert_eq!(service(&c, "codex").stats["skillsCodex"], Some(2));
    assert!(c
        .items
        .iter()
        .any(|i| i.kind == "skill" && i.status == "unknown"));
    let output = serde_json::to_string(&c).unwrap();
    assert!(!output.contains("CANARY_SECRET_7F3A"));
    assert!(!output.contains("token-hidden"));
    safe::OPENED.with(|p| assert!(p.borrow().iter().all(|p| !safe::private(p))));
}
#[test]
fn script_filename_never_contains_command_arguments() {
    assert_eq!(
        safe::script_name("python \"C:/synthetic/folder name/hooks.py\" --token hidden"),
        "hooks.py"
    );
    assert_eq!(safe::script_name("echo hidden"), "unsupported");
    for command in [
        "echo CANARY_SECRET_7F3A.py",
        "unknown --output CANARY_SECRET_7F3A.py",
        "python /synthetic/.claude/tokens/CANARY_SECRET_7F3A.py",
        "token-probe.exe --output ignored",
        "cmd.exe /c echo CANARY_SECRET_7F3A.py",
        "powershell -Command Write-Output CANARY_SECRET_7F3A.py",
    ] {
        assert_eq!(safe::script_name(command), "unsupported");
    }
    assert_eq!(
        safe::script_name("python3.12 hook.py --auth hidden"),
        "hook.py"
    );
    assert_eq!(
        safe::script_name("python -X utf8 -W ignore hook.py --mode check"),
        "hook.py"
    );
    assert_eq!(
        safe::script_name("python -X CANARY_SECRET_7F3A.py hook.py -e ignored"),
        "hook.py"
    );

    assert_eq!(
        safe::script_name("python hook.py --output CANARY_SECRET_7F3A.py"),
        "hook.py"
    );
    assert_eq!(
        safe::script_name("python -c \"print('CANARY_SECRET_7F3A.py')\""),
        "unsupported"
    );
    assert_eq!(
        safe::script_name("python.exe -u hook.py --token ignored"),
        "hook.py"
    );
    assert_eq!(
        safe::script_name("python --token CANARY_SECRET_7F3A.py"),
        "unsupported"
    );
    for file in [
        ".env",
        "x.env",
        "credentials-example",
        "auth.json",
        "token-a",
        "private.key",
        "private.pem",
    ] {
        assert!(safe::text(Path::new(file), 1024).is_none());
    }
}
#[test]
fn readonly_skills_reuse_stage1_sources_without_cache_writes_or_body_markers() {
    let f = Fixture::new("both");
    let c = f.catalog();
    let before = fs::read(f.home().join(".claude/settings.json")).unwrap();
    let shelf = skill_read::catalog(f.home(), &c);
    assert!(shelf["skills"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "reviewer"));
    assert!(!serde_json::to_string(&shelf)
        .unwrap()
        .contains("CANARY_SECRET_7F3A"));
    let doc = skill_read::read(f.home(), &c, "document", "reviewer", None, None, None).unwrap();
    assert!(doc["body"]
        .as_str()
        .unwrap()
        .contains("sample@example.test"));
    assert!(skill_read::read(f.home(), &c, "export", "reviewer", None, None, None).is_err());
    assert_eq!(
        fs::read(f.home().join(".claude/settings.json")).unwrap(),
        before
    );
    assert!(!f.home().join(".mycmux/skills/cache.json").exists());
}

#[test]
fn transcript_line_and_size_limits_leave_missing_values_unknown() {
    let f = Fixture::new("empty");
    let path = f.home().join("limited.jsonl");
    let rows="{\"type\":\"progress\"}\n".repeat(128)+"{\"type\":\"attachment\",\"attachment\":{\"type\":\"skill_listing\",\"isInitial\":true,\"content\":\"CANARY_BODY_9C1D\"}}\n";
    fs::write(&path, rows).unwrap();
    let session = records::claude(
        &path,
        &Default::default(),
        &Default::default(),
        &Default::default(),
        None,
    );
    assert_eq!(session.lines_read, 128);
    assert_eq!(session.stopped_at, "lineLimit");
    assert_eq!(session.listing.chars, None);
    let row=format!("{{\"type\":\"attachment\",\"attachment\":{{\"type\":\"skill_listing\",\"isInitial\":true,\"content\":\"{}\"}}}}\n","x".repeat(4*1024*1024+1));
    fs::write(&path, row).unwrap();
    let session = records::claude(
        &path,
        &Default::default(),
        &Default::default(),
        &Default::default(),
        None,
    );
    assert_eq!(session.stopped_at, "byteLimit");
    assert_eq!(session.listing.chars, None);
}
#[test]
fn unicode_characters_are_counted_separately_from_file_bytes() {
    let f = Fixture::new("claude_only");
    let c = f.catalog();
    let item = c
        .items
        .iter()
        .find(|i| {
            i.path
                .as_ref()
                .is_some_and(|p| Path::new(p) == f.home().join(".claude/CLAUDE.md"))
        })
        .unwrap();
    let text = fs::read_to_string(f.home().join(".claude/CLAUDE.md")).unwrap();
    assert!(text.contains("\u{65e5}\u{672c}\u{8a9e}"));
    assert_eq!(item.size.chars, Some(text.chars().count() as u64));
    assert!(item.size.bytes.unwrap() > item.size.chars.unwrap());
}
#[test]
fn system_skills_are_excluded_from_personal_implicit_findings() {
    let f = Fixture::new("both");
    let before = f.catalog();
    write(
        f.home(),
        ".codex/skills/.system/system-sample/agents/openai.yaml",
        "policy:\n  allow_implicit_invocation: false\n",
    );
    let after = f.catalog();
    assert_eq!(
        service(&before, "codex").stats["implicitOff"],
        service(&after, "codex").stats["implicitOff"]
    );
    let finding = after
        .findings
        .iter()
        .find(|f| f.kind == "implicitHidden")
        .unwrap();
    assert!(!finding.names.iter().any(|name| name == "system-sample"));
}
#[test]
fn closures_do_not_hide_a_different_working_folder() {
    let f = Fixture::new("both");
    let mut c = f.catalog();
    inspect::save_close(
        &state_dir(f.home()),
        &mut c,
        "codex:shadowedAgents",
        "Intentional project override",
    )
    .unwrap();
    let other = f.home().join("other");
    fs::create_dir(&other).unwrap();
    let c = collect(
        f.home(),
        &other,
        &f.home().join(".codex"),
        &f.home().join(".hermes"),
        &scheduled::Jobs::default(),
        (None, None),
    );
    assert_eq!(c.closed_count, 0);
    assert!(c.findings.iter().any(|f| f.kind == "shadowedAgents"));
}
#[test]
fn metadata_document_apis_never_return_private_values_or_memory_bodies() {
    let f = Fixture::new("both");
    let mut c = f.catalog();
    for item in &c.items {
        if let Ok(value) = document(f.home(), f.home(), &c, &item.id) {
            let text = serde_json::to_string(&value).unwrap();
            assert!(!text.contains("CANARY_SECRET_7F3A"));
            assert!(!text.contains("CANARY_BODY_9C1D"));
        }
    }
    let item = c.items.iter_mut().find(|i| i.kind == "settings").unwrap();
    item.path = Some(f.home().join(".codex/auth.json").to_string_lossy().into());
    item.fields.push(Field::new("count", 1));
    let id = item.id.clone();
    assert!(document(f.home(), f.home(), &c, &id).is_err());
}

#[test]
fn readonly_skills_support_initial_listing_aliases_and_command_files() {
    let f = Fixture::new("both");
    let mut c = f.catalog();
    let service = c.services.iter_mut().find(|s| s.id == "claude").unwrap();
    service
        .session
        .listing
        .entries
        .iter_mut()
        .find(|e| e.name == "remote")
        .unwrap()
        .name = "anthropic-skills:remote".into();
    write(f.home(), ".claude/commands/plain.md", "# Plain command\n");
    let shelf = skill_read::catalog(f.home(), &c);
    let rows = shelf["skills"].as_array().unwrap();
    assert!(rows
        .iter()
        .any(|r| r["id"] == "help" && r["docPath"].is_null()));
    assert!(rows
        .iter()
        .any(|r| r["id"] == "sample-command" && r["kind"] == "command"));
    assert!(rows.iter().any(|r| r["id"] == "plain"));
    assert!(rows
        .iter()
        .any(|r| r["id"] == "anthropic-skills:remote" && !r["docPath"].is_null()));
    let document = skill_read::read(
        f.home(),
        &c,
        "document",
        "anthropic-skills:remote",
        None,
        None,
        None,
    )
    .unwrap();
    assert!(document["body"].as_str().unwrap().contains("# Remote"));
    assert!(!serde_json::to_string(&shelf)
        .unwrap()
        .contains("CANARY_SECRET_7F3A"));
}

#[test]
fn readonly_skills_use_live_usage_and_manual_shelf_without_a_snapshot() {
    let f = Fixture::new("both");
    let c = f.catalog();
    write(f.home(), ".claude.json", r#"{"skillUsage":{"ReViEwEr":{"usageCount":11,"lastUsedAt":2000}}}"#);
    write(f.home(), ".mycmux/skills/shelf.json", r##"{
        "categories":[{"id":"sample-manual","name":"Sample manual","color":"#64748B","symbol":null}],
        "skills":{"REVIEWER":{"category":"sample-manual","label":"Manual sample","symbol":null}}
    }"##);
    write(f.home(), ".mycmux/skills/shelf_auto.json", r#"{"skills":{"reviewer":{"category":"unsorted","label":"Automatic sample"}}}"#);
    let ledger = json!({"sample-session":{"mtimeNs":chrono::Utc::now().timestamp_nanos_opt().unwrap(),"skills":["reviewer","reviewer"],"last":3000}});
    write(f.home(), ".mycmux/skills/usage_codex.json", &ledger.to_string());
    let shelf = skill_read::catalog(f.home(), &c);
    let row = shelf["skills"].as_array().unwrap().iter().find(|r|r["id"]=="reviewer").unwrap();
    assert_eq!(row["usage"], json!({"claude":11,"codex":1}));
    assert_eq!(row["usageCount"], 12);
    assert_eq!(row["lastUsedAt"].as_f64(), Some(3000.0));
    assert_eq!(row["category"], "sample-manual");
    assert_eq!(row["label"], "Manual sample");
    assert_eq!(row["curation"], "manual");
    assert_eq!(row["codexRecorded"], true);
    assert!(!f.home().join(".mycmux/skills/cache.json").exists());
    assert_eq!(row["body"], "");
    assert!(shelf["categories"].as_array().unwrap().iter().any(|c| c["id"] == "sample-manual"));

    // The design snapshot and an unrelated stage 1 cache can both be old.
    write(f.home(), ".mycmux/skills/cache.json", r#"{"skills":[{"id":"reviewer","category":"stale","usageCount":999,"usage":{"claude":999,"codex":0}}]}"#);
    write(f.home(), ".claude.json", r#"{"skillUsage":{"reviewer":{"usageCount":20}}}"#);
    write(f.home(), ".mycmux/skills/shelf.json", r#"{"skills":{"reviewer":{"category":"code","label":"Updated sample"}}}"#);
    let after = skill_read::catalog(f.home(), &c);
    let updated = after["skills"].as_array().unwrap().iter().find(|r| r["id"] == "reviewer").unwrap();
    assert_eq!(updated["usageCount"], 21);
    assert_eq!(updated["usage"], json!({"claude":20,"codex":1}));
    assert_eq!(updated["category"], "code");
    assert_eq!(updated["label"], "Updated sample");
    assert_eq!(safe::json(&f.home().join(".mycmux/skills/cache.json")).unwrap()["skills"][0]["usageCount"], 999);
}

#[test]
#[ignore = "manual material parity; requires an explicit fixture home and Python reference"]
fn readonly_skills_match_explicit_python_reference() {
    let h = PathBuf::from(std::env::var_os("MYCMUX_SKILLS_REFERENCE_HOME").expect("explicit fixture home"));
    assert!(h.is_absolute() && h.is_dir());
    let c = collect(&h, &h, &h.join(".codex"), &h.join(".hermes"), &scheduled::Jobs::default(), (None, None));
    let shelf = skill_read::catalog(&h, &c);
    let expected = safe::json(&h.join("expected.json")).expect("Python reference rows");
    let rows: Vec<_> = expected.as_array().unwrap().iter().map(|want| {
        let row = shelf["skills"].as_array().unwrap().iter()
            .find(|r| r["id"].as_str().unwrap().eq_ignore_ascii_case(want["id"].as_str().unwrap()))
            .expect("registered reference skill");
        json!({"id":want["id"],"usage":row["usage"],"usageCount":row["usageCount"],"category":row["category"]})
    }).collect();
    fs::write(h.join("actual.json"), serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
    assert_eq!(json!(rows), expected);
}

#[test]
fn portable_windows_memory_references_survive_open_completion_and_cache() {
    let f = Fixture::new("both");
    let mut c = f.catalog();
    let mut memory = c.items.iter()
        .find(|i| i.kind == "memoryIndex").unwrap().clone();
    let path = r"C:\Users\runneradmin\AppData\Local\Temp\.tmpABC123\.claude\projects\C--Users-runneradmin-AppData-Local-Temp--tmpABC123\memory\MEMORY.md";
    memory.id = format!("claude:memoryIndex:{path}");
    memory.path = Some(path.into());
    assert!(!memory.document_allowed);
    let windows_id = memory.id.clone();
    c.items.push(memory);
    portable::complete(&mut c, f.home(), f.home());
    scrub_catalog(&mut c);
    let ids: BTreeSet<_> = c.items.iter().map(|i| i.id.as_str()).collect();
    let references: Vec<_> = c.layers.iter()
        .flat_map(|l| &l.item_ids)
        .chain(c.reading_flows.iter().flat_map(|f| &f.steps).flat_map(|s| &s.item_ids))
        .chain(c.compare_rows.iter().flat_map(|r| &r.cells).flat_map(|c| &c.item_ids))
        .collect();
    assert!(references.iter().all(|id| ids.contains(id.as_str())));
    assert!(references.iter().any(|id| *id == &windows_id));
    let before = serde_json::to_value(&c).unwrap();
    let settings = c.items.iter().find(|i| i.kind == "settings").unwrap();
    let opened = opened_document(f.home(), f.home(), &c, &settings.id).unwrap();
    assert!(opened["body"].is_string());
    portable::complete(&mut c, f.home(), f.home());
    assert_eq!(serde_json::to_value(&c).unwrap(), before);
    save(f.home(), &c).unwrap();
    let saved: Value = serde_json::from_slice(
        &fs::read(state_dir(f.home()).join("catalog.json")).unwrap(),
    ).unwrap();
    assert_eq!(saved, before);
    let cached = cached(f.home(), f.home()).unwrap();
    assert_eq!(serde_json::to_value(cached).unwrap(), before);
    assert!(!saved.to_string().contains("CANARY_SECRET_7F3A"));
}

#[test]
fn portable_catalog_contains_four_surfaces_and_matches_api_without_canaries() {
    for mode in ["claude_only", "codex_only", "both", "empty"] {
        let f = Fixture::new(mode);
        let c = f.catalog();
        assert_eq!(c.schema_version, 1);
        assert_eq!(c.refresh_ms.fract(), 0.0);
        assert!(c.generator.starts_with("mycmux/"));
        assert_eq!(c.work_folder, c.cwd);
        assert!(chrono::DateTime::parse_from_rfc3339(&c.generated_at).is_ok());
        assert_eq!(c.layers.len(), 7);
        assert_eq!(c.compare_rows.len(), 14);
        assert!(c.compare_rows.iter().all(|r| r.cells.len() == 3));
        assert_eq!(c.reading_flows.len(), 3);
        assert!(c
            .reading_flows
            .iter()
            .all(|r| r.steps.len() == if r.service == "hermes" { 0 } else { 12 }));
        for id in c.layers.iter().flat_map(|l| &l.item_ids) {
            assert!(c.items.iter().any(|i| &i.id == id));
        }
        for (id, doc) in &c.documents {
            assert_eq!(*doc, document(f.home(), f.home(), &c, id).unwrap());
        }
        save(f.home(), &c).unwrap();
        let path = state_dir(f.home()).join("catalog.json");
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("CANARY_SECRET_7F3A"));
        assert!(!text.contains("CANARY_BODY_9C1D"));
        let saved: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(saved, serde_json::to_value(&c).unwrap());
        let cached = cached(f.home(), f.home()).unwrap();
        assert_eq!(serde_json::to_value(cached).unwrap(), saved);
        assert!(safe::write_json(&state_dir(f.home()), "../catalog.json", &c).is_err());
    }
}
fn closure(cwd: &Path, id: &str, from: &str) -> Closure {
    Closure {
        id: id.into(),
        cwd: cwd.to_string_lossy().into(),
        reason: "Intentional synthetic design".into(),
        date: "2026-01-02T03:04:05+09:00".into(),
        closed_from: from.into(),
    }
}
#[test]
fn stale_pc_and_iphone_revisions_are_reread_and_merged_by_stable_id() {
    let f = Fixture::new("both");
    let dir = state_dir(f.home());
    let observed = closed_store::read(&dir).unwrap();
    let (first, reloaded) = closed_store::merge(
        &dir,
        observed.revision,
        closure(f.home(), "codex:implicitHidden", "iphone"),
    )
    .unwrap();
    assert!(!reloaded);
    assert_eq!(first.revision, 1);
    let (second, reloaded) = closed_store::merge(
        &dir,
        observed.revision,
        closure(f.home(), "codex:shadowedAgents", "pc"),
    )
    .unwrap();
    assert!(reloaded);
    assert_eq!(second.revision, 2);
    assert_eq!(second.closed.len(), 2);
    assert_eq!(second.closed[0].closed_from, "iphone");
    assert_eq!(second.closed[1].closed_from, "pc");
    let text = fs::read_to_string(dir.join("closed.json")).unwrap();
    assert!(
        text.contains("\"workFolder\"")
            && text.contains("\"closedAt\"")
            && text.contains("\"closedFrom\"")
    );
    assert!(!text.contains("\"cwd\"") && !text.contains("\"date\""));
    let c = f.catalog();
    assert_eq!(c.closed_count, 2);
    assert_eq!(c.closed_revision, 2);
    assert!(!c
        .findings
        .iter()
        .any(|f| ["implicitHidden", "shadowedAgents"].contains(&f.kind.as_str())));
}
#[test]
fn concurrent_closed_writers_keep_all_additions_and_readers_see_whole_json() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Barrier,
    };
    let f = Fixture::new("empty");
    let home = f.home().to_owned();
    let dir = state_dir(&home);
    fs::create_dir_all(&dir).unwrap();
    let finished = Arc::new(AtomicBool::new(false));
    let flag = finished.clone();
    let target = dir.join("closed.json");
    let reader = std::thread::spawn(move || {
        while !flag.load(Ordering::SeqCst) {
            if let Ok(text) = fs::read_to_string(&target) {
                serde_json::from_str::<Closed>(&text).expect("atomic whole JSON");
            }
            std::thread::yield_now();
        }
    });
    let barrier = Arc::new(Barrier::new(16));
    let writers: Vec<_> = (0..16)
        .map(|n| {
            let b = barrier.clone();
            let dir = dir.clone();
            let home = home.clone();
            std::thread::spawn(move || {
                b.wait();
                closed_store::merge(
                    &dir,
                    0,
                    closure(
                        &home,
                        &format!("synthetic:duplicate:skill{n}"),
                        if n % 2 == 0 { "pc" } else { "iphone" },
                    ),
                )
                .unwrap();
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    finished.store(true, Ordering::SeqCst);
    reader.join().unwrap();
    let c = closed_store::read(&dir).unwrap();
    assert_eq!(c.closed.len(), 16);
    assert_eq!(c.revision, 16);
    let (c, stale) = closed_store::merge(
        &dir,
        0,
        closure(&home, "synthetic:duplicate:skill0", "iphone"),
    )
    .unwrap();
    assert!(stale);
    assert_eq!(c.closed.len(), 16);
    assert_eq!(c.revision, 17);
    assert_eq!(
        c.closed
            .iter()
            .find(|c| c.id == "synthetic:duplicate:skill0")
            .unwrap()
            .closed_from,
        "iphone"
    );
}
#[test]
fn phone_closure_is_applied_to_cached_catalog_and_finding_ids_survive_refresh() {
    let f = Fixture::new("both");
    let c = f.catalog();
    let ids: Vec<_> = c.findings.iter().map(|f| f.id.clone()).collect();
    assert_eq!(
        ids,
        f.catalog()
            .findings
            .iter()
            .map(|f| f.id.clone())
            .collect::<Vec<_>>()
    );
    save(f.home(), &c).unwrap();
    closed_store::merge(
        &state_dir(f.home()),
        0,
        closure(f.home(), "codex:implicitHidden", "iphone"),
    )
    .unwrap();
    let c = cached(f.home(), f.home()).unwrap();
    assert_eq!(c.closed_count, 1);
    assert_eq!(c.closed_revision, 1);
    assert!(!c.findings.iter().any(|f| f.id == "codex:implicitHidden"));
}
#[test]
fn invalid_phone_closure_preserves_current_file() {
    let f = Fixture::new("empty");
    let dir = state_dir(f.home());
    closed_store::merge(&dir, 0, closure(f.home(), "synthetic:first", "pc")).unwrap();
    let before = fs::read(dir.join("closed.json")).unwrap();
    let mut invalid = closure(f.home(), "synthetic:second", "iphone");
    invalid.date = "not-a-time".into();
    assert!(closed_store::merge(&dir, 1, invalid).is_err());
    assert_eq!(fs::read(dir.join("closed.json")).unwrap(), before);
}

fn record_mtime(path: &Path, seconds: u64) {
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
}
fn start_record(path: &Path, timestamp: &str, cwd: Option<&Path>) {
    let text = if let Some(cwd) = cwd {
        let folder = serde_json::to_string(&cwd.to_string_lossy()).unwrap();
        format!(
            r#"{{"timestamp":"2020-01-01T00:00:00Z","type":"session_meta","payload":{{"timestamp":"{timestamp}","cwd":{folder},"base_instructions":{{}}}}}}"#
        )
    } else {
        format!(
            r#"{{"timestamp":"{timestamp}","type":"assistant","message":{{"content":"CANARY_BODY_9C1D"}}}}"#
        )
    };
    fs::write(path, text + "\n").unwrap();
}
#[test]
fn claude_selects_latest_start_instead_of_resumed_record_mtime() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let root = cwd.join(".claude");
    let directory = root.join("projects").join(safe::project_key(&cwd));
    fs::create_dir_all(&directory).unwrap();
    let old = directory.join("older-start.jsonl");
    let new = directory.join("newer-start.jsonl");
    start_record(&old, "2026-10-05T22:41:28+09:00", None);
    start_record(&new, "2026-10-07T17:16:17+09:00", None);
    record_mtime(&old, 1_900_000_000);
    record_mtime(&new, 1_000_000_000);
    assert_eq!(records::latest_claude(&root, &cwd), Some(new.clone()));
    let session = records::claude(
        &new,
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        None,
    );
    assert_eq!(
        session.started_at.as_deref(),
        Some("2026-10-07T17:16:17+09:00")
    );
    let bytes = fs::read(&new).unwrap();
    let mut reader = std::io::Cursor::new(&bytes);
    let prefix = records::initial_header(&mut reader, false).unwrap();
    assert!(!prefix.contains("CANARY_BODY_9C1D"));
    assert!(
        reader.position()
            < bytes
                .windows(b"CANARY_BODY_9C1D".len())
                .position(|w| w == b"CANARY_BODY_9C1D")
                .unwrap() as u64
    );
    start_record(&old, "2026-10-07T17:16:17+09:00", None);
    record_mtime(&old, 1_900_000_000);
    assert_eq!(records::latest_claude(&root, &cwd), Some(old.clone()));
    start_record(&old, "invalid", None);
    if let Ok(created) = fs::metadata(&old).unwrap().created() {
        assert_eq!(
            records::claude(
                &old,
                &BTreeSet::new(),
                &BTreeSet::new(),
                &BTreeSet::new(),
                None
            )
            .started_at,
            Some(chrono::DateTime::<chrono::Utc>::from(created).to_rfc3339())
        );
    }
}
#[test]
fn codex_selects_latest_session_meta_start_instead_of_resumed_record_mtime() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let root = cwd.join(".codex");
    let directory = root.join("sessions/2026/10/07");
    fs::create_dir_all(&directory).unwrap();
    let old = directory.join("rollout-2026-10-07T20-00-00-old.jsonl");
    let new = directory.join("rollout-2026-10-05T01-00-00-new.jsonl");
    start_record(&old, "2026-10-05T22:41:28+09:00", Some(&cwd));
    start_record(&new, "2026-10-07T17:16:17+09:00", Some(&cwd));
    record_mtime(&old, 1_900_000_000);
    record_mtime(&new, 1_000_000_000);
    let other = directory.join("rollout-other-cwd.jsonl");
    start_record(&other, "2029-01-01T00:00:00Z", Some(&cwd.join("other")));
    assert_eq!(records::latest_codex(&root, &cwd), Some(new.clone()));
    assert_eq!(
        records::codex(&new, &BTreeMap::new()).started_at.as_deref(),
        Some("2026-10-07T17:16:17+09:00")
    );
    let data = format!(
        r#"{{"timestamp":"2026-10-07T08:16:17Z","type":"session_meta","payload":{{"cwd":{},"base_instructions":"CANARY_BODY_9C1D"}}}}"#,
        serde_json::to_string(&cwd.to_string_lossy()).unwrap()
    );
    let mut reader = std::io::Cursor::new(data.as_bytes());
    let prefix = records::initial_header(&mut reader, true).unwrap();
    assert!(!prefix.contains("CANARY_BODY_9C1D"));
    assert!(reader.position() < data.find("CANARY_BODY_9C1D").unwrap() as u64);
    start_record(&old, "2026-10-07T17:16:17+09:00", Some(&cwd));
    record_mtime(&old, 1_900_000_000);
    assert_eq!(records::latest_codex(&root, &cwd), Some(old));
}
#[test]
fn codex_start_falls_back_to_filename_when_metadata_timestamp_is_unavailable() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let root = cwd.join(".codex");
    let directory = root.join("sessions");
    fs::create_dir_all(&directory).unwrap();
    let old = directory.join("rollout-2026-10-05T22-41-28-old.jsonl");
    let new = directory.join("rollout-2026-10-07T17-16-17-new.jsonl");
    for path in [&old, &new] {
        let text = format!(
            r#"{{"type":"session_meta","payload":{{"cwd":{},"base_instructions":{{}}}}}}"#,
            serde_json::to_string(&cwd.to_string_lossy()).unwrap()
        );
        fs::write(path, text).unwrap();
    }
    record_mtime(&old, 1_900_000_000);
    record_mtime(&new, 1_000_000_000);
    assert_eq!(records::latest_codex(&root, &cwd), Some(new.clone()));
    assert!(records::codex(&new, &BTreeMap::new())
        .started_at
        .unwrap()
        .starts_with("2026-10-07T17:16:17"));
    let legacy = serde_json::json!({"file":"legacy.jsonl","linesRead":0,"bytesConsumed":0,"stoppedAt":"eof",
        "listing":{"count":null,"chars":null,"entries":[],"groups":[],"pluginCounts":{},"disabledCounts":{},"disabledChars":null},
        "startupHooks":[],"startupChars":null,"sections":[]});
    let session: Session = serde_json::from_value(legacy).unwrap();
    assert!(session.started_at.is_none());
}

#[test]
fn first_request_markup_is_not_mistaken_for_initial_instructions() {
    for prefix in ["# ", "<request>"] {
        let f = Fixture::new("codex_only");
        let path = records::latest_codex(&f.home().join(".codex"), f.home()).unwrap();
        let data = fs::read_to_string(&path).unwrap();
        let head = data
            .lines()
            .filter(|l| !l.contains("\"world_state\"") && !l.contains("CANARY_BODY_9C1D"))
            .collect::<Vec<_>>()
            .join("\n");
        let request = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("{prefix}CANARY_BODY_9C1D")}]}});
        let text = head + "\n" + &serde_json::to_string(&request).unwrap() + "\n";
        fs::write(&path, &text).unwrap();
        let s = records::codex(&path, &BTreeMap::new());
        assert_eq!(s.stopped_at, "firstRequest");
        assert!(s.bytes_consumed < text.find("CANARY_BODY_9C1D").unwrap() as u64);
    }
}

type CandidateTime = chrono::DateTime<chrono::Utc>;
type Candidate = (Option<CandidateTime>, PathBuf);

fn selection_corpus(
    codex: bool,
) -> (
    TempDir,
    PathBuf,
    PathBuf,
    Vec<Candidate>,
    Vec<PathBuf>,
    PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let root = cwd.join(if codex { ".codex" } else { ".claude" });
    let base = chrono::DateTime::parse_from_rfc3339("2026-10-07T09:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let mut candidates = Vec::new();
    let mut files = Vec::new();
    let mut winner = None;
    // File creation order, header starts, and mtimes deliberately disagree.
    for k in 0..200 {
        let i = (k * 73) % 200;
        let hint = base - chrono::Duration::minutes((199 - i) * 15);
        let start = hint + chrono::Duration::minutes((i * 13) % 61 - 30);
        let folder = if i % 5 != 0 || i == 0 {
            cwd.clone()
        } else {
            cwd.join("other")
        };
        let directory = if codex {
            root.join("sessions")
        } else {
            root.join("projects").join(safe::project_key(&folder))
        };
        fs::create_dir_all(&directory).unwrap();
        let name = if codex && i == 0 {
            "rollout-undated.jsonl".to_owned()
        } else if codex {
            format!(
                "rollout-{}-{i:03}.jsonl",
                hint.with_timezone(&chrono::Local)
                    .format("%Y-%m-%dT%H-%M-%S")
            )
        } else {
            format!("record-{i:03}.jsonl")
        };
        let path = directory.join(name);
        let text = if codex {
            let payload =
                serde_json::json!({"timestamp":start.to_rfc3339(),"cwd":folder.to_string_lossy()});
            format!(
                r#"{{"timestamp":"2020-01-01T00:00:00Z","type":"session_meta","payload":{payload}}}"#
            )
        } else {
            serde_json::json!({"timestamp":start.to_rfc3339(),"type":"assistant",
                "cwd":folder.to_string_lossy()})
            .to_string()
        };
        fs::write(&path, format!("{text}\n")).unwrap();
        record_mtime(&path, 1_000_000_000 + ((i * 97) % 200) as u64 * 10_000);
        if i == 197 {
            winner = Some(path.clone());
        }
        candidates.push((if i == 0 { None } else { Some(hint) }, path.clone()));
        files.push(path);
    }
    (temp, root, cwd, candidates, files, winner.unwrap())
}

fn exhaustive_header_choice(
    paths: &[PathBuf],
    codex: bool,
    root: &Path,
    cwd: &Path,
) -> Option<PathBuf> {
    let own = root.join("projects").join(safe::project_key(cwd));
    paths
        .iter()
        .filter_map(|path| {
            let file = safe::open(path).unwrap();
            let text = records::initial_header(&mut std::io::BufReader::new(file), codex).unwrap();
            let row: serde_json::Value = serde_json::from_str(&text).unwrap();
            if codex {
                if safe::normalized(Path::new(row["payload"]["cwd"].as_str().unwrap()))
                    != safe::normalized(cwd)
                {
                    return None;
                }
            } else if path.parent() != Some(own.as_path()) {
                return None;
            }
            let time = if codex {
                &row["payload"]["timestamp"]
            } else {
                &row["timestamp"]
            };
            let start = chrono::DateTime::parse_from_rfc3339(time.as_str().unwrap())
                .unwrap()
                .with_timezone(&chrono::Utc);
            Some(((start, safe::modified(path), path.clone()), path.clone()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, path)| path)
}

#[test]
fn codex_200_candidates_match_exhaustive_with_fewer_headers() {
    let (_temp, root, cwd, _candidates, files, winner) = selection_corpus(true);
    safe::OPENED.with(|paths| paths.borrow_mut().clear());
    let exhaustive = exhaustive_header_choice(&files, true, &root, &cwd);
    safe::OPENED.with(|paths| assert_eq!(paths.borrow().len(), 200));
    assert_eq!(exhaustive, Some(winner.clone()));
    safe::OPENED.with(|paths| paths.borrow_mut().clear());
    assert_eq!(records::latest_codex(&root, &cwd), exhaustive);
    safe::OPENED.with(|paths| {
        let paths = paths.borrow();
        assert!(paths.len() <= 12, "opened {} headers", paths.len());
        assert!(paths
            .iter()
            .any(|path| safe::basename(path) == "rollout-undated.jsonl"));
    });
    // The winner has an older filename than the first cwd match, but a
    // newer session_meta start within the one-hour overlap.
    assert!(safe::basename(&winner).ends_with("-197.jsonl"));
}

#[test]
fn claude_200_candidates_match_exhaustive_with_fewer_headers() {
    let (_temp, root, cwd, candidates, files, winner) = selection_corpus(false);
    safe::OPENED.with(|paths| paths.borrow_mut().clear());
    let exhaustive = exhaustive_header_choice(&files, false, &root, &cwd);
    safe::OPENED.with(|paths| assert_eq!(paths.borrow().len(), 200));
    assert_eq!(exhaustive, Some(winner));
    // Creation times cannot be set portably. Supply the controlled creation
    // metadata at the same selection boundary used by latest_claude.
    let own = root.join("projects").join(safe::project_key(&cwd));
    let candidates = candidates
        .into_iter()
        .filter(|(_, path)| path.parent() == Some(own.as_path()))
        .collect();
    safe::OPENED.with(|paths| paths.borrow_mut().clear());
    assert_eq!(records::select_latest(candidates, false, &cwd), exhaustive);
    safe::OPENED.with(|paths| {
        let paths = paths.borrow();
        assert!(paths.len() <= 12, "opened {} headers", paths.len());
        assert!(paths
            .iter()
            .all(|path| path.parent() == Some(own.as_path())));
        assert!(paths
            .iter()
            .any(|path| safe::basename(path) == "record-000.jsonl"));
    });
    // Also verify the public folder-key entrypoint against the exhaustive
    // answer with the actual filesystem's creation timestamps.
    assert_eq!(records::latest_claude(&root, &cwd), exhaustive);
}

#[test]
fn markdown_open_response_renders_frontmatter_structure_and_drops_active_content() {
    let f = Fixture::new("both");
    let raw = "---\r\npaths:\r\n  - src/**\r\n---\r\n# Heading\r\n\r\n- Item\r\n\r\n| A | B |\r\n|---|---|\r\n| One | Two |\r\n\r\n> Quote\r\n\r\n\x60\x60\x60rust\r\nlet value = 1;\r\n\x60\x60\x60\r\n\r\n[Link](https://example.test)\r\n\r\n<script>AD_SCRIPT_CANARY</script><img src=x onerror=\"AD_EVENT_CANARY\"><a href=\"javascript:AD_LINK_CANARY\" onclick=\"AD_CLICK_CANARY\">Blocked</a>\r\n";
    write(f.home(), ".claude/CLAUDE.md", raw);
    let c = f.catalog();
    let id = &c.items.iter().find(|i| has_path(i, &f.home().join(".claude/CLAUDE.md"))).unwrap().id;
    let response = opened_document(f.home(), f.home(), &c, id).unwrap();
    assert_eq!(response["body"], raw);
    assert_eq!(response["frontmatter"]["paths"], json!(["src/**"]));
    assert_eq!(response["toc"], json!([{"level":1,"text":"Heading"}]));
    let html = response["html"].as_str().unwrap();
    for tag in ["<h1>", "<ul>", "<table>", "<blockquote>", "<pre><code>", "https://example.test"] {
        assert!(html.contains(tag), "missing {tag}: {html}");
    }
    for marker in ["<script", "onerror", "onclick", "javascript:", "AD_SCRIPT_CANARY", "AD_EVENT_CANARY", "AD_LINK_CANARY", "AD_CLICK_CANARY", "|---|"] {
        assert!(!html.contains(marker), "active content: {marker}");
    }
    assert_eq!(html, stage1_bridge::detail::markdown(frontmatter::split(raw).1));
}

#[test]
fn markdown_open_does_not_grow_portable_documents_or_catalogue() {
    let f = Fixture::new("both");
    let mut c = f.catalog();
    let before = serde_json::to_vec(&c).unwrap();
    let before_documents = serde_json::to_vec(&c.documents).unwrap();
    for item in c.items.iter().filter(|i| i.document_allowed) {
        let response = opened_document(f.home(), f.home(), &c, &item.id).unwrap();
        assert!(response["body"].is_string());
    }
    portable::complete(&mut c, f.home(), f.home());
    assert_eq!(serde_json::to_vec(&c.documents).unwrap(), before_documents);
    assert_eq!(serde_json::to_vec(&c).unwrap(), before);
    for doc in c.documents.values() {
        for name in ["html", "toc", "frontmatter"] {
            assert!(doc.get(name).is_none(), "catalogue must not carry {name}");
        }
    }
    println!("portable documents bytes before={} after={}; catalogue bytes before={} after={}; HTML keys=0",
        before_documents.len(), serde_json::to_vec(&c.documents).unwrap().len(), before.len(), serde_json::to_vec(&c).unwrap().len());
}

#[test]
fn markdown_open_preserves_non_markdown_and_private_document_contracts() {
    let f = Fixture::new("both");
    write(f.home(), ".claude/references/plain.txt", "plain <text>");
    let c = f.catalog();
    let item = c.items.iter().find(|i| has_path(i, &f.home().join(".claude/references/plain.txt"))).unwrap();
    assert_eq!(opened_document(f.home(), f.home(), &c, &item.id).unwrap()["body"],"plain <text>");
    assert!(document(f.home(), f.home(), &c, &item.id).unwrap()["body"].is_null());
    let settings = c.items.iter().find(|i| i.kind == "settings").unwrap();
    assert!(opened_document(f.home(), f.home(), &c, &settings.id).unwrap().get("html").is_none());
    let mut forged = c.clone();
    let item = forged.items.iter_mut().find(|i| i.document_allowed).unwrap();
    let id = item.id.clone();
    item.path = Some(f.home().join(".codex/auth.json").to_string_lossy().into());
    assert!(opened_document(f.home(), f.home(), &forged, &id).is_err());
}

#[test]
#[ignore = "manual read-only Markdown response export; explicit isolated input/output paths only"]
fn export_markdown_acceptance_responses() {
    let input = PathBuf::from(std::env::var_os("MYCMUX_MD_INPUT").expect("explicit isolated input"));
    let output = PathBuf::from(std::env::var_os("MYCMUX_MD_OUTPUT").expect("explicit isolated output"));
    assert!(input.is_absolute() && output.is_absolute() && !output.exists());
    let manifest: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
    let f = Fixture::new("both");
    for entry in manifest.as_array().unwrap() {
        let relative=entry["relative"].as_str().unwrap();
        assert!([".claude/",".codex/",".hermes/",".agents/"].iter().any(|root|relative.starts_with(root)) && !relative.contains(".."));
        write(f.home(),relative,entry["body"].as_str().unwrap());
    }
    let mut c=f.catalog();
    let responses:Vec<_>=manifest.as_array().unwrap().iter().enumerate().filter(|(_,entry)|entry["supportOnly"]!=true).map(|(n,entry)| {
        let path=f.home().join(entry["relative"].as_str().unwrap());
        let kind=entry["kind"].as_str().unwrap_or("reference");let service=entry["service"].as_str().unwrap_or("claude");
        let id=if let Some(item)=c.items.iter().find(|i|i.kind==kind && has_path(i,&path)){item.id.clone()}else{
            let id=format!("acceptance-{n}");
            c.items.push(Item{id:id.clone(),service:service.into(),layer:entry["layer"].as_u64().unwrap_or(7) as u8,display_name:safe::basename(&path),
                path:Some(path.to_string_lossy().into()),kind:kind.into(),status:"present".into(),size:safe::size(&path,false),read_timing:"onDemand".into(),
                evidence:"declaration".into(),modified_at:safe::modified(&path),fields:vec![],conditions:vec![],document_allowed:false,active:true});id
        };
        json!({"source":entry["source"],"relative":entry["relative"],"kind":kind,"service":service,"photo":entry["photo"],"document":opened_document(f.home(),f.home(),&c,&id).unwrap()})
    }).collect();
    fs::write(&output, serde_json::to_vec_pretty(&responses).unwrap()).unwrap();
    println!("isolated real-input Markdown responses exported: {}", responses.len());
}

#[test]
fn open_all_every_registered_type_including_hermes_has_content_or_specific_reason() {
    let f=Fixture::new("both");
    for (path,body) in [
        (".hermes/config.yaml","model: example\napi_token: CANARY_SECRET_7F3A\n"),
        (".hermes/SOUL.md","# Soul\nFull instruction.\n"),
        (".hermes/memories/MEMORY.md","# Memories\nComplete index.\n"),
        (".hermes/skills/example/SKILL.md","# Example\nUse this procedure.\n"),
        (".hermes/cron/job.yaml","schedule: daily\n"),
        (".claude/skills/reviewer/run.py","print('read only')\n"),
        (".claude/skills/reviewer/.env","VISIBLE=CANARY_SECRET_7F3A\n"),
        (".claude/jobs/job.json","{\"schedule\":\"daily\",\"token\":\"CANARY_SECRET_7F3A\"}"),
    ] {write(f.home(),path,body);}
    let c=f.catalog();let mut kinds=std::collections::BTreeSet::new();let mut opened=0;
    for item in &c.items {
        let response=full_content::opened(f.home(),f.home(),&c,&item.id,None,0).unwrap();
        assert!(response["body"].is_string() || response["files"].as_array().is_some_and(|a|!a.is_empty()) || response["reason"].is_string(),"no explanation for {}",item.kind);
        kinds.insert(item.kind.clone());opened+=1;
    }
    for kind in ["runtime","settings","settingsLocal","instruction","override","shadowedInstruction","rule","memoryIndex","memoryDirectory","skill","agent","command","mcp","plugins","skillListing","hooks","script","scheduled","privateCount","permissionRules","reference","cron"] {
        assert!(kinds.contains(kind),"missing registered kind: {kind}");
    }
    let skill=c.items.iter().find(|i|has_path(i,&f.home().join(".claude/skills/reviewer/SKILL.md"))).unwrap();
    let doc=full_content::opened(f.home(),f.home(),&c,&skill.id,None,0).unwrap();
    assert!(doc["html"].is_string());
    assert!(doc["files"].as_array().unwrap().iter().any(|v|v["name"]=="run.py"));
    let file=full_content::opened(f.home(),f.home(),&c,&skill.id,Some("0/run.py"),0).unwrap();
    assert_eq!(file["body"],"print('read only')\n");assert!(file.get("html").is_none());
    let private=full_content::opened(f.home(),f.home(),&c,&skill.id,Some("0/.env"),0).unwrap();
    assert!(!private.to_string().contains("CANARY_SECRET_7F3A"));
    println!("C all-types registered_kinds={} opened={} skill_folder=PASS private_file=PASS",kinds.len(),opened);
}
#[test]
fn open_all_reveal_returns_one_value_rechecks_revision_and_does_not_write_original() {
    let f=Fixture::new("both");
    let raw="{\r\n\"api_token\":\"CANARY_SECRET_7F3A\",\r\n\"password\":\"SECOND_PRIVATE_VALUE\",\r\n\"public\":\"hello\"\r\n}\r\n";
    write(f.home(),".claude/settings.json",raw);let path=f.home().join(".claude/settings.json");
    let before=fs::read(&path).unwrap();let modified=fs::metadata(&path).unwrap().modified().unwrap();
    let c=f.catalog();let item=c.items.iter().find(|i|i.kind=="settings" && i.service=="claude").unwrap();
    let doc=full_content::opened(f.home(),f.home(),&c,&item.id,None,0).unwrap();
    assert!(!doc.to_string().contains("CANARY_SECRET_7F3A"));assert!(!doc.to_string().contains("SECOND_PRIVATE_VALUE"));
    assert_eq!(doc["masks"].as_array().unwrap().len(),2);
    let revision=doc["revision"].as_str().unwrap();
    assert_eq!(full_content::reveal(f.home(),f.home(),&c,&item.id,doc["relative"].as_str(),0,revision).unwrap(),"CANARY_SECRET_7F3A");
    assert_eq!(full_content::reveal(f.home(),f.home(),&c,&item.id,doc["relative"].as_str(),1,revision).unwrap(),"SECOND_PRIVATE_VALUE");
    assert!(full_content::reveal(f.home(),f.home(),&c,&item.id,None,9,revision).is_err());
    assert!(full_content::reveal(f.home(),f.home(),&c,&item.id,Some("0/../../.codex/auth.json"),0,revision).is_err());
    assert_eq!(fs::read(&path).unwrap(),before);assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(),modified);
    write(f.home(),".claude/settings.json","{\"token\":\"changed\"}");
    assert_eq!(full_content::reveal(f.home(),f.home(),&c,&item.id,None,0,revision).unwrap_err(),"documentChanged");
    println!("C reveal_one=PASS stale_revision=DENIED original_bytes=UNCHANGED original_mtime=UNCHANGED");
}
#[test]
fn open_all_catalogue_portable_export_and_saved_cache_are_secret_free_and_do_not_grow_on_open() {
    let f=Fixture::new("both");
    write(f.home(),".claude/CLAUDE.md","# Instructions\napi_token = \"CANARY_SECRET_7F3A\"\n");
    write(f.home(),".codex/config.toml","model = \"example\"\napi_token = \"CANARY_SECRET_7F3A\"\n");
    let mut c=f.catalog();let before=serde_json::to_vec(&c).unwrap();let docs=serde_json::to_vec(&c.documents).unwrap();
    assert!(!String::from_utf8(before.clone()).unwrap().contains("CANARY_SECRET_7F3A"));
    for item in &c.items {let _=full_content::opened(f.home(),f.home(),&c,&item.id,None,0).unwrap();}
    portable::complete(&mut c,f.home(),f.home());
    assert_eq!(serde_json::to_vec(&c).unwrap(),before);assert_eq!(serde_json::to_vec(&c.documents).unwrap(),docs);
    for doc in c.documents.values() {for field in ["html","masks","files","revision"] {assert!(doc.get(field).is_none());}}
    save(f.home(),&c).unwrap();
    let saved=fs::read_to_string(f.home().join(".mycmux/agent_design/catalog.json")).unwrap();
    assert!(!saved.contains("CANARY_SECRET_7F3A"));
    println!("C portable/export bytes before={} after={} documents before={} after={} secrets=0 expanded_content_fields=0 cache_secrets=0",before.len(),serde_json::to_vec(&c).unwrap().len(),docs.len(),serde_json::to_vec(&c.documents).unwrap().len());
}
#[test]
fn open_all_limits_preserve_full_size_leading_text_and_specific_unavailable_reasons() {
    let f=Fixture::new("both");let path=f.home().join(".claude/references/large.txt");
    let raw="x".repeat(safe::DOCUMENT_LIMIT as usize+200);write(f.home(),".claude/references/large.txt",&raw);
    let before=fs::metadata(&path).unwrap().modified().unwrap();
    let read=full_content::read_text(&path).unwrap();assert!(read.truncated);assert_eq!(read.bytes,raw.len() as u64);assert_eq!(read.text.len(),safe::DOCUMENT_LIMIT as usize);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(),before);
    let c=f.catalog();let item=c.items.iter().find(|i|has_path(i,&path)).unwrap();
    let doc=full_content::opened(f.home(),f.home(),&c,&item.id,None,0).unwrap();assert_eq!(doc["truncated"],true);assert_eq!(doc["size"]["bytes"],raw.len() as u64);
    let missing=full_content::opened(f.home(),f.home(),&c,&item.id,Some("0/missing.md"),0).unwrap();assert_eq!(missing["reason"],"fileMissing");
    fs::write(f.home().join(".claude/references/binary.bin"),[0,1,2]).unwrap();
    assert_eq!(full_content::read_text(&f.home().join(".claude/references/binary.bin")).err().unwrap(),"binaryFile");
    fs::write(f.home().join(".claude/references/invalid.txt"),[0xff,0x80]).unwrap();
    assert_eq!(full_content::read_text(&f.home().join(".claude/references/invalid.txt")).err().unwrap(),"unsupportedEncoding");
    println!("C >2MiB prefix_bytes={} total_bytes={} read_only=PASS missing/binary/encoding=SPECIFIC",read.text.len(),read.bytes);
}
#[test]
fn open_all_directory_pagination_and_nested_private_files_are_navigable() {
    let f=Fixture::new("both");
    for n in 0..505 {write(f.home(),&format!(".claude/skills/reviewer/many/{n:03}.txt"),"public");}
    write(f.home(),".claude/skills/reviewer/many/token-data","CANARY_SECRET_7F3A");
    let c=f.catalog();let item=c.items.iter().find(|i|has_path(i,&f.home().join(".claude/skills/reviewer/SKILL.md"))).unwrap();
    let first=full_content::opened(f.home(),f.home(),&c,&item.id,Some("0/many"),0).unwrap();
    assert_eq!(first["fileCount"],506);assert_eq!(first["files"].as_array().unwrap().len(),500);assert_eq!(first["folder"],"0/many");
    let second=full_content::opened(f.home(),f.home(),&c,&item.id,Some("0/many"),500).unwrap();assert_eq!(second["files"].as_array().unwrap().len(),6);assert_eq!(second["parent"],"0/");
    let private=full_content::opened(f.home(),f.home(),&c,&item.id,Some("0/many/token-data"),0).unwrap();assert!(!private.to_string().contains("CANARY_SECRET_7F3A"));
}

#[test]
fn open_all_mcp_and_declared_external_hook_files_are_exactly_scoped() {
    let f=Fixture::new("both");
    write(f.home(),"outside-hooks/run.py","print('declared source')\n");
    write(f.home(),"outside-hooks/credentials.txt","CANARY_SECRET_7F3A");
    let command=format!("python \"{}\"",f.home().join("outside-hooks/run.py").display());
    write(f.home(),".claude/settings.json",&json!({"hooks":{"Stop":[{"hooks":[{"command":command}]}]}}).to_string());
    write(f.home(),".claude.json","{\"mcpServers\":{\"sample\":{\"env\":{\"API_TOKEN\":\"CANARY_SECRET_7F3A\"}}}}");
    let c=f.catalog();
    let hooks=c.items.iter().find(|i|i.kind=="hooks" && i.service=="claude").unwrap();
    let first=full_content::opened(f.home(),f.home(),&c,&hooks.id,None,0).unwrap();
    let file=first["files"].as_array().unwrap().iter().find(|v|v["name"]=="run.py").unwrap();
    let id=file["id"].as_str().unwrap();
    let source=full_content::opened(f.home(),f.home(),&c,&hooks.id,Some(id),0).unwrap();
    assert_eq!(source["body"],"print('declared source')\n");
    let sibling=format!("{}/credentials.txt",id.split('/').next().unwrap());
    assert!(full_content::opened(f.home(),f.home(),&c,&hooks.id,Some(&sibling),0).is_err());
    let mcp=c.items.iter().find(|i|i.kind=="mcp" && i.service=="claude").unwrap();
    let first=full_content::opened(f.home(),f.home(),&c,&mcp.id,None,0).unwrap();
    let file=first["files"].as_array().unwrap().iter().find(|v|v["name"]==".claude.json").unwrap();
    let config=full_content::opened(f.home(),f.home(),&c,&mcp.id,file["id"].as_str(),0).unwrap();
    assert!(config["body"].as_str().unwrap().contains("mcpServers"));assert!(!config.to_string().contains("CANARY_SECRET_7F3A"));
    println!("C MCP user config=PASS declared_hook=PASS undeclared_sibling=DENIED");
}

#[cfg(target_os = "macos")]
#[test]
fn open_all_scheduled_definition_keeps_reveal_ephemeral_and_source_unchanged() {
    let f=Fixture::new("both");
    let script=f.home().join(".claude/scripts/scheduled.py");
    write(f.home(),".claude/scripts/scheduled.py","print('read only')\n");
    let raw=format!("<plist><dict><key>Label</key><string>synthetic-job</string><key>ProgramArguments</key><array><string>python</string><string>{}</string><string>--token</string><string>CANARY_SECRET_7F3A</string></array><key>ApiToken</key><string>CANARY_SECRET_7F3A</string></dict></plist>",script.to_string_lossy());
    write(f.home(),"Library/LaunchAgents/synthetic.plist",&raw);
    let source=f.home().join("Library/LaunchAgents/synthetic.plist");
    let before=fs::read(&source).unwrap();let mtime=fs::metadata(&source).unwrap().modified().unwrap();
    let c=f.catalog();let item=c.items.iter().find(|i|i.service=="claude"&&i.kind=="scheduled").unwrap();
    let doc=full_content::opened(f.home(),f.home(),&c,&item.id,None,0).unwrap();
    assert!(!doc.to_string().contains("CANARY_SECRET_7F3A"));
    assert!(!doc["masks"].as_array().unwrap().is_empty());
    let values=doc["masks"].as_array().unwrap().iter().map(|mask|full_content::reveal(f.home(),f.home(),&c,&item.id,None,mask["index"].as_u64().unwrap() as usize,doc["revision"].as_str().unwrap()).unwrap()).collect::<Vec<_>>();
    assert!(values.iter().any(|value|value=="CANARY_SECRET_7F3A"));
    let folder=full_content::opened(f.home(),f.home(),&c,&item.id,Some("0/"),0).unwrap();
    assert!(!folder.to_string().contains("CANARY_SECRET_7F3A"));
    let mask=&folder["masks"].as_array().unwrap()[0];
    assert!(full_content::reveal(f.home(),f.home(),&c,&item.id,Some("0/"),mask["index"].as_u64().unwrap() as usize,folder["revision"].as_str().unwrap()).unwrap().contains("CANARY_SECRET_7F3A"));
    assert_eq!(fs::read(&source).unwrap(),before);assert_eq!(fs::metadata(&source).unwrap().modified().unwrap(),mtime);
    println!("C scheduled default_secrets=0 reveal_one=PASS folder_reveal=PASS original_bytes=UNCHANGED original_mtime=UNCHANGED");
}

#[test]
fn v04_skill_records_keep_units_window_and_source_unchanged() {
    let f = Fixture::new("both");
    let now = chrono::Utc::now().timestamp_millis() as f64;
    write(f.home(), ".claude.json", &json!({"skillUsage":{"reviewer":{"usageCount":"7","lastUsedAt":now-1000.0}}}).to_string());
    let ledger = json!({"one":{"mtimeNs":now*1_000_000.0,"last":now,"skills":["reviewer","reviewer","REVIEWER"]},"old":{"mtimeNs":(now-100.0*86400000.0)*1_000_000.0,"last":now,"skills":["reviewer"]}}).to_string();
    write(f.home(), ".mycmux/skills/usage_codex.json", &ledger);
    write(f.home(), ".mycmux/skills/cache.json", "{\"skills\":[{\"id\":\"reviewer\",\"usageCount\":999}]}");
    let source = f.home().join(".mycmux/skills/usage_codex.json");
    let mtime = fs::metadata(&source).unwrap().modified().unwrap();
    let c = f.catalog();
    let shelf = skill_read::catalog(f.home(), &c);
    let row = shelf["skills"].as_array().unwrap().iter().find(|row| row["id"] == "reviewer").unwrap();
    assert_eq!(row["usageRecords"]["claude"]["count"], 7);
    assert_eq!(row["usageRecords"]["codex"]["count"], 1);
    assert_eq!(row["usageRecords"]["codex"]["days"], 90);
    assert_eq!(row["usageRecords"]["codex"]["lastAt"], now);
    assert_eq!(row["usageRecords"]["sampledAt"], c.generated_at);
    assert!(!row["places"].as_array().unwrap().is_empty());
    assert!(row["places"].as_array().unwrap().iter().all(|place| place["bytes"].as_u64().is_some()));
    assert_eq!(fs::read_to_string(source.clone()).unwrap(), ledger);
    assert_eq!(fs::metadata(source).unwrap().modified().unwrap(), mtime);
}

#[test]
fn v04_skill_records_missing_and_failed_are_not_zero_records() {
    let f = Fixture::new("both");
    write(f.home(), ".claude.json", "{}");
    let c = f.catalog();
    let find = |shelf: Value| shelf["skills"].as_array().unwrap().iter().find(|row| row["id"] == "reviewer").unwrap().clone();
    let missing = find(skill_read::catalog(f.home(), &c));
    assert_eq!(missing["usageRecords"]["claude"]["status"], "unavailable");
    assert!(missing["usageRecords"]["claude"]["count"].is_null());
    assert_eq!(missing["usageRecords"]["codex"]["status"], "unavailable");
    write(f.home(), ".mycmux/skills/usage_codex.json", "{broken");
    write(f.home(), ".claude.json", "{\"skillUsage\":{\"reviewer\":{\"usageCount\":\"bad\"}}}");
    let failed = find(skill_read::catalog(f.home(), &c));
    assert_eq!(failed["usageRecords"]["claude"]["status"], "failed");
    assert_eq!(failed["usageRecords"]["codex"]["status"], "failed");
    assert!(failed["usageRecords"]["claude"]["count"].is_null());
    assert!(failed["usageRecords"]["codex"]["count"].is_null());
}

#[test]
fn v04_closed_entries_are_scoped_masked_and_optional_for_old_catalogs() {
    let f = Fixture::new("both");
    let mut c = f.catalog();
    let closed = Closed { schema_version: 1, revision: 2, closed: vec![Closure { id: "synthetic".into(), cwd: c.cwd.clone(), reason: "api_token = CANARY_SECRET_7F3A".into(), date: "2026-10-08T12:00:00+09:00".into(), closed_from: "pc".into() }, Closure { id: "other".into(), cwd: "/synthetic/other".into(), reason: "Other folder".into(), date: "2026-10-08T12:00:00+09:00".into(), closed_from: "pc".into() }] };
    inspect::apply_closed(&mut c, &closed);
    scrub_catalog(&mut c);
    assert_eq!(c.closed_count, 1);
    assert_eq!(c.closed_entries.as_ref().unwrap().len(), 1);
    assert_eq!(c.closed_entries.as_ref().unwrap()[0].date, "2026-10-08T12:00:00+09:00");
    assert!(!serde_json::to_string(&c).unwrap().contains("CANARY_SECRET_7F3A"));
    let mut old = serde_json::to_value(c).unwrap();
    old.as_object_mut().unwrap().remove("closedEntries");
    let old: Catalog = serde_json::from_value(old).unwrap();
    assert!(old.closed_entries.is_none());
}

#[test]
fn integrated_skill_usage_keeps_v04_records_for_aliases_and_hidden_rows() {
    let f = Fixture::new("both");
    write(f.home(), ".codex/skills/review-helper/SKILL.md", "---\nname: review-helper\ndescription: Alias sample\n---\n# Alias sample\n");
    write(f.home(), ".codex/skills/hidden-example/SKILL.md", "---\nname: hidden-example\ndescription: Hidden sample\n---\n# Hidden sample\n");
    write(f.home(), ".claude.json", r#"{"skillUsage":{"ReViEwEr":{"usageCount":"7","lastUsedAt":2000},"review-helper":{"usageCount":2,"lastUsedAt":2500}}}"#);
    write(f.home(), ".mycmux/skills/shelf.json", r##"{
        "categories":[{"id":"integrated","name":"Integrated sample","color":"#64748B","symbol":null}],
        "aliases":{"review-helper":"reviewer"},"hidden":["hidden-example"],
        "skills":{"reviewer":{"category":"integrated","label":"Integrated sample"}}
    }"##);
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let ledger = json!({
        "one":{"mtimeNs":now*1_000_000.0,"last":3000,"skills":["reviewer","reviewer","REVIEWER","hidden-example"]},
        "two":{"mtimeNs":now*1_000_000.0,"last":4000,"skills":["review-helper"]}
    }).to_string();
    write(f.home(), ".mycmux/skills/usage_codex.json", &ledger);
    let source = f.home().join(".mycmux/skills/usage_codex.json");
    let before_mtime = fs::metadata(&source).unwrap().modified().unwrap();
    let c = f.catalog();
    let shelf = skill_read::catalog(f.home(), &c);
    let row = shelf["skills"].as_array().unwrap().iter().find(|row| row["id"] == "reviewer").unwrap();
    assert_eq!(row["category"], "integrated");
    assert_eq!(row["label"], "Integrated sample");
    assert_eq!(row["curation"], "manual");
    assert_eq!(row["aliases"], json!(["review-helper"]));
    assert_eq!(row["usage"], json!({"claude":9,"codex":2}));
    assert_eq!(row["usageCount"], 11);
    assert_eq!(row["usageRecords"]["claude"]["count"], row["usage"]["claude"]);
    assert_eq!(row["usageRecords"]["codex"]["count"], row["usage"]["codex"]);
    assert_eq!(row["usageRecords"]["codex"]["lastAt"], 4000.0);
    assert_eq!(row["usageRecords"]["sampledAt"], c.generated_at);
    assert!(row["places"].as_array().unwrap().iter().any(|place| place["path"].as_str().unwrap().contains("review-helper")));
    assert!(row["places"].as_array().unwrap().iter().all(|place| place["bytes"].as_u64().is_some()));
    assert_eq!(shelf["hiddenCount"], 1);
    let hidden = &shelf["hiddenSkills"][0];
    assert_eq!(hidden["id"], "hidden-example");
    assert_eq!(hidden["usageRecords"]["codex"]["status"], "available");
    assert_eq!(hidden["usageRecords"]["codex"]["count"], 1);
    assert_eq!(hidden["body"], "");
    assert!(!hidden["places"].as_array().unwrap().is_empty());
    assert_eq!(row["body"], "");
    assert!(!f.home().join(".mycmux/skills/cache.json").exists());
    assert_eq!(fs::read_to_string(&source).unwrap(), ledger);
    assert_eq!(fs::metadata(source).unwrap().modified().unwrap(), before_mtime);
}
