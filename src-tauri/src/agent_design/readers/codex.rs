use super::*;
pub fn read(home: &Path, root: &Path, cwd: &Path, jobs: &Jobs, version: Option<String>) -> Scan {
    let mut scan = Scan::new("codex", "Codex", root);
    scan.service.version = version;
    if !root.is_dir() {
        return scan;
    }
    let path = root.join("config.toml");
    let idx = scan.item(2, &path, "settings", "outside", false, false);
    let mut flags: BTreeMap<String, Vec<bool>> = BTreeMap::new();
    if let Some(raw) = safe::text(&path, safe::DOCUMENT_LIMIT) {
        if let Ok(config) = raw.parse::<toml_edit::DocumentMut>() {
            for key in [
                "model",
                "model_reasoning_effort",
                "approval_policy",
                "sandbox_mode",
                "personality",
            ] {
                if let Some(v) = config
                    .get(key)
                    .and_then(|v| v.as_str())
                    .and_then(safe::identifier)
                {
                    scan.service.settings.push(Field::new(key, v));
                }
            }
            let mcp = config.get("mcp_servers").and_then(|v| v.as_table_like());
            scan.service
                .stat("mcp", Some(mcp.map(|v| v.len() as u64).unwrap_or(0)));
            scan.service.stat(
                "mcpDisabled",
                Some(
                    mcp.map(|v| {
                        v.iter()
                            .filter(|(_, v)| {
                                v.get("enabled").and_then(|v| v.as_bool()) == Some(false)
                            })
                            .count() as u64
                    })
                    .unwrap_or(0),
                ),
            );
            scan.service.stat(
                "mcpCommented",
                Some(
                    raw.lines()
                        .filter(|l| {
                            l.trim_start().starts_with('#')
                                && l.contains("[mcp_servers.")
                                && !l
                                    .split("[mcp_servers.")
                                    .nth(1)
                                    .unwrap_or("")
                                    .split(']')
                                    .next()
                                    .unwrap_or("")
                                    .contains('.')
                        })
                        .count() as u64,
                ),
            );
            let plugins = config.get("plugins").and_then(|v| v.as_table_like());
            scan.service.stat(
                "plugins",
                Some(plugins.map(|v| v.len() as u64).unwrap_or(0)),
            );
            let mut enabled = 0;
            if let Some(plugins) = plugins {
                for (key, v) in plugins.iter() {
                    let on = v
                        .get("enabled")
                        .and_then(|v| v.as_bool())
                        .or_else(|| v.as_bool())
                        .unwrap_or(true);
                    if on {
                        enabled += 1;
                    }
                    if let Some(key) = safe::identifier(key) {
                        flags
                            .entry(key.split('@').next().unwrap_or(&key).into())
                            .or_default()
                            .push(on);
                        scan.service
                            .settings
                            .push(Field::new(&format!("plugin:{key}"), on));
                    }
                }
            }
            scan.service.stat("pluginsEnabled", Some(enabled));
            if let Some(mcp) = mcp {
                for (key, v) in mcp.iter() {
                    if let Some(key) = safe::identifier(key) {
                        scan.service.settings.push(Field::new(
                            &format!("mcp:{key}"),
                            v.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
                        ));
                    }
                }
            }
            scan.service.stat(
                "projects",
                Some(
                    config
                        .get("projects")
                        .and_then(|v| v.as_table_like())
                        .map(|v| v.len() as u64)
                        .unwrap_or(0),
                ),
            );
            let unsupported = config
                .iter()
                .filter(|(key, _)| {
                    ![
                        "model",
                        "model_reasoning_effort",
                        "approval_policy",
                        "sandbox_mode",
                        "personality",
                        "mcp_servers",
                        "plugins",
                        "projects",
                    ]
                    .contains(key)
                })
                .count();
            if unsupported > 0 {
                scan.service
                    .settings
                    .push(Field::new("unsupported", unsupported));
            }
            if let Some(idx) = idx {
                scan.items[idx].fields = scan.service.settings.clone();
            }
        } else if let Some(idx) = idx {
            scan.items[idx].status = "unknown".into();
        }
    }
    let hook_path = root.join("hooks.json");
    let mut known_hooks = !hook_path.exists();
    if let Some(raw) = safe::text(&hook_path, safe::DOCUMENT_LIMIT) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            scan.service.hooks = hooks(&v, &hook_path, &raw);
            known_hooks = true;
        }
    }
    add_hook_links(&mut scan, known_hooks);
    scan.item(
        3,
        &root.join("AGENTS.md"),
        "instruction",
        "always",
        true,
        true,
    );
    for folder in chain(cwd) {
        let override_path = folder.join("AGENTS.override.md");
        let agents_path = folder.join("AGENTS.md");
        if override_path.is_file() {
            let over = scan.item(3, &override_path, "override", "always", true, true);
            if agents_path.is_file() {
                if let Some(idx) = scan.item(
                    3,
                    &agents_path,
                    "shadowedInstruction",
                    "outside",
                    true,
                    true,
                ) {
                    scan.items[idx].active = false;
                    if let Some(over) = over {
                        scan.links.push(Link {
                            id: format!("override:{}", scan.items[idx].id),
                            from: scan.items[over].id.clone(),
                            to: scan.items[idx].id.clone(),
                            source_service: "codex".into(),
                            target_service: "codex".into(),
                            relation: "shadows".into(),
                            evidence: "product".into(),
                            line: None,
                            target_path: Some(agents_path.to_string_lossy().into()),
                            exists: Some(true),
                        });
                    }
                }
            }
        } else if agents_path.is_file() {
            scan.item(3, &agents_path, "instruction", "always", true, true);
        }
    }
    let memories = root.join("memories");
    scan.service.stat(
        "memoryFiles",
        safe::files(&memories, None).map(|v| v.len() as u64),
    );
    for (file, key) in [
        ("memory_summary.md", "memorySummaryChars"),
        ("MEMORY.md", "memoryIndexChars"),
    ] {
        let p = memories.join(file);
        scan.item(4, &p, "memoryIndex", "onDemand", true, false);
        scan.service.stat(key, safe::size(&p, true).chars);
    }
    let cache = load_stage1(home);
    skills_at(&mut scan, &root.join("skills"), "skillsCodex", &cache, home);
    skills_at(
        &mut scan,
        &home.join(".agents/skills"),
        "skillsAgents",
        &cache,
        home,
    );
    skills_at(
        &mut scan,
        &root.join("skills/.system"),
        "skillsSystem",
        &cache,
        home,
    );
    let agents = count_direct(&root.join("agents"), "toml");
    scan.service
        .stat("agents", agents.as_ref().map(|v| v.len() as u64));
    if let Some(paths) = agents {
        for path in paths {
            scan.item(5, &path, "agent", "onDemand", false, false);
        }
    }
    let rules = root.join("rules/default.rules");
    scan.item(2, &rules, "permissionRules", "outside", false, false);
    scan.service.stat(
        "rulesBytes",
        std::fs::metadata(&rules).ok().map(|m| m.len()),
    );
    scan.count_dir("references", &root.join("references"), None, 7, "reference");
    scan.count_dir(
        "scripts",
        &root.join("scripts"),
        Some(SCRIPT_EXTS),
        6,
        "script",
    );
    if let Some(path) = records::latest_codex(root, cwd) {
        scan.service.session = records::codex(&path, &flags);
    }
    for kind in ["instructions", "memory"] {
        let values: Vec<_> = scan
            .service
            .session
            .sections
            .iter()
            .filter(|s| s.kind == kind)
            .collect();
        let n = (!values.is_empty()).then(|| values.iter().map(|s| s.chars).sum());
        if kind == "instructions" {
            scan.service.context.instructions = n;
        } else {
            scan.service.context.memory = n;
        }
    }
    scan.service.context.product = (!scan.service.session.sections.is_empty()).then(|| {
        scan.service
            .session
            .sections
            .iter()
            .filter(|s| ["product", "environment", "otherProduct"].contains(&s.kind.as_str()))
            .map(|s| s.chars)
            .sum()
    });
    scan.service.context.listing = scan.service.session.listing.chars;
    scan.service.context.startup = None;
    scan.service.stat("scheduledJobs", jobs.codex);
    scan.service.stat("scheduledEnabled", jobs.codex_enabled);
    scan.service.stat(
        "implicitOff",
        Some(
            scan.items
                .iter()
                .filter(|i| {
                    i.kind == "skill"
                        && i.fields
                            .iter()
                            .any(|f| f.key == "sourceKind" && f.value == "own")
                        && i.fields
                            .iter()
                            .any(|f| f.key == "allowImplicitInvocation" && f.value == "false")
                })
                .count() as u64,
        ),
    );
    finish_context(&mut scan.service, false);
    scan
}
