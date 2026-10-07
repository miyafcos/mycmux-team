use super::*;
pub fn read(home: &Path, cwd: &Path, jobs: &Jobs, version: Option<String>) -> Scan {
    let root = home.join(".claude");
    let mut scan = Scan::new("claude", "Claude Code", &root);
    scan.service.version = version;
    if !root.is_dir() {
        return scan;
    }
    let cache = load_stage1(home);
    let mut known_hooks = !root.join("settings.json").exists();
    for (file, local) in [("settings.json", false), ("settings.local.json", true)] {
        let path = root.join(file);
        let idx = scan.item(
            2,
            &path,
            if local { "settingsLocal" } else { "settings" },
            "outside",
            false,
            false,
        );
        if let Some(raw) = safe::text(&path, safe::DOCUMENT_LIMIT) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                let mut fields = vec![];
                for key in ["model", "effortLevel"] {
                    if let Some(value) = safe_scalar(&v[key]) {
                        fields.push(Field::new(key, value));
                    }
                }
                if let Some(mode) = safe_scalar(&v["permissions"]["defaultMode"]) {
                    fields.push(Field::new("defaultMode", mode));
                }
                let allow = v["permissions"]["allow"]
                    .as_array()
                    .map(|v| v.len() as u64)
                    .unwrap_or(0);
                let env = v["env"].as_object().map(|v| v.len() as u64).unwrap_or(0);
                fields.push(Field::new("allowCount", allow));
                fields.push(Field::new("envCount", env));
                scan.service
                    .stat(if local { "allowLocal" } else { "allow" }, Some(allow));
                scan.service
                    .stat(if local { "envLocalCount" } else { "envCount" }, Some(env));
                let unsupported = v
                    .as_object()
                    .map(|m| {
                        m.keys()
                            .filter(|k| {
                                ![
                                    "model",
                                    "effortLevel",
                                    "permissions",
                                    "env",
                                    "hooks",
                                    "enabledPlugins",
                                ]
                                .contains(&k.as_str())
                            })
                            .count()
                    })
                    .unwrap_or(0);
                if unsupported > 0 {
                    fields.push(Field::new("unsupported", unsupported));
                }
                if let Some(idx) = idx {
                    scan.items[idx].fields = fields.clone();
                }
                if !local {
                    known_hooks = true;
                    scan.service.settings = fields;
                    scan.service.hooks = hooks(&v, &path, &raw);
                    if let Some(plugins) = v["enabledPlugins"].as_object() {
                        scan.service.stat("plugins", Some(plugins.len() as u64));
                        scan.service.stat(
                            "pluginsEnabled",
                            Some(
                                plugins
                                    .values()
                                    .filter(|v| v.as_bool() == Some(true))
                                    .count() as u64,
                            ),
                        );
                        for (name, on) in plugins {
                            if let Some(name) = safe::identifier(name) {
                                let field = Field::new(
                                    &format!("plugin:{name}"),
                                    on.as_bool().unwrap_or(false),
                                );
                                scan.service.settings.push(field.clone());
                                if let Some(idx) = idx {
                                    scan.items[idx].fields.push(field);
                                }
                            }
                        }
                    }
                } else {
                    let local_hooks = hooks(&v, &path, &raw);
                    scan.service
                        .stat("localHookHandlers", Some(local_hooks.len() as u64));
                    for h in local_hooks {
                        if let Some(idx) = idx {
                            scan.items[idx]
                                .fields
                                .push(Field::new(&format!("hook:{}", h.event), &h.script));
                            scan.items[idx]
                                .fields
                                .push(Field::new("matcher", &h.matcher));
                        }
                        scan.links.push(Link {
                            id: format!("claude:localHook:{}:{}", h.event, scan.links.len()),
                            from: h.event,
                            to: h.script,
                            source_service: "claude".into(),
                            target_service: "claude".into(),
                            relation: "executes".into(),
                            evidence: "declaration".into(),
                            line: h.line,
                            target_path: None,
                            exists: None,
                        });
                    }
                }
            } else if let Some(idx) = idx {
                scan.items[idx].status = "unknown".into();
            }
        } else if path.exists() {
            if let Some(idx) = idx {
                scan.items[idx].status = "unknown".into();
            }
        }
    }
    add_hook_links(&mut scan, known_hooks);
    let mut instruction_chars = 0;
    let mut instruction_unknown = false;
    let mut documents = vec![root.join("CLAUDE.md")];
    documents.extend(
        chain(cwd)
            .into_iter()
            .map(|p| p.join("CLAUDE.md"))
            .filter(|p| p.exists()),
    );
    documents.dedup();
    for path in documents {
        if let Some(idx) = scan.item(3, &path, "instruction", "always", true, true) {
            if path.exists() {
                if let Some(n) = scan.items[idx].size.chars {
                    instruction_chars += n;
                } else {
                    instruction_unknown = true;
                }
            }
        }
    }
    let mut rule_count = 0;
    let mut always_count = 0;
    let mut conditional_count = 0;
    let mut always_chars = 0;
    let mut rule_chars = 0;
    let rules = count_direct(&root.join("rules"), "md");
    if let Some(rules) = &rules {
        for path in rules {
            let Some(text) = safe::text(path, safe::DOCUMENT_LIMIT) else {
                instruction_unknown = true;
                continue;
            };
            let (fm, _) = frontmatter::split(&text);
            let conditional = fm.get("paths").is_some();
            let chars = text.chars().count() as u64;
            rule_count += 1;
            rule_chars += chars;
            if conditional {
                conditional_count += 1;
            } else {
                always_count += 1;
                always_chars += chars;
            }
            if let Some(idx) = scan.item(
                3,
                path,
                "rule",
                if conditional { "conditional" } else { "always" },
                true,
                true,
            ) {
                scan.items[idx].conditions = fm["paths"]
                    .as_array()
                    .map(|v| {
                        v.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_else(|| {
                        fm["paths"]
                            .as_str()
                            .map(|s| vec![s.to_owned()])
                            .unwrap_or_default()
                    });
                references(&mut scan, idx, &text, &root);
            }
        }
    }
    scan.service
        .stat("rules", rules.as_ref().map(|_| rule_count));
    scan.service
        .stat("rulesChars", rules.as_ref().map(|_| rule_chars));
    scan.service
        .stat("rulesAlways", rules.as_ref().map(|_| always_count));
    scan.service.stat(
        "rulesConditional",
        rules.as_ref().map(|_| conditional_count),
    );
    scan.service
        .stat("rulesAlwaysChars", rules.as_ref().map(|_| always_chars));
    if rules.is_none() {
        instruction_unknown = true;
    }
    scan.service.context.instructions =
        (!instruction_unknown).then_some(instruction_chars + always_chars);
    let memory = root
        .join("projects")
        .join(safe::project_key(cwd))
        .join("memory/MEMORY.md");
    scan.item(4, &memory, "memoryIndex", "always", true, false);
    let memory_size = safe::size(&memory, true);
    scan.service.stat("memoryIndexLines", memory_size.lines);
    scan.service.stat("memoryIndexChars", memory_size.chars);
    scan.service.context.memory = safe::text(&memory, safe::DOCUMENT_LIMIT).map(|text| {
        let first = text.split_inclusive('\n').take(200).collect::<String>();
        first.chars().take(25000).count() as u64
    });
    if !memory.exists() {
        scan.service.context.memory = Some(0);
    }
    let dirs = safe::children(&root.join("projects")).map(|v| {
        v.into_iter()
            .map(|p| p.join("memory"))
            .filter(|p| p.is_dir())
            .collect::<Vec<_>>()
    });
    scan.service
        .stat("memoryDirs", dirs.as_ref().map(|v| v.len() as u64));
    let counts = dirs.as_ref().and_then(|v| {
        v.iter()
            .map(|p| safe::files(p, None).map(|v| v.len() as u64))
            .collect::<Option<Vec<_>>>()
    });
    scan.service
        .stat("memoryFiles", counts.map(|v| v.iter().sum()));
    let own = skills_at(&mut scan, &root.join("skills"), "skillsOwn", &cache, home);
    let synced_files = safe::files(&root.join("skills/synced"), Some(&["md"]));
    let mut synced = BTreeSet::new();
    let mut sync_count = 0;
    if let Some(paths) = &synced_files {
        for path in paths.iter().filter(|p| safe::basename(p) == "SKILL.md") {
            if let Some(name) = skill(&mut scan, path, &cache, home) {
                synced.insert(name);
                sync_count += 1;
            }
        }
    }
    scan.service
        .stat("skillsSynced", synced_files.map(|_| sync_count));
    let command_paths = safe::children(&root.join("commands"));
    let mut commands = BTreeSet::new();
    if let Some(paths) = &command_paths {
        for path in paths {
            if path.is_file() && path.extension().is_some_and(|e| e == "md") {
                commands.insert(
                    path.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                );
                scan.item(5, path, "command", "onDemand", true, true);
            } else if path.join("SKILL.md").is_file() {
                commands.insert(safe::basename(path));
                scan.item(5, &path.join("SKILL.md"), "command", "onDemand", true, true);
            }
        }
    }
    scan.service
        .stat("commands", command_paths.map(|_| commands.len() as u64));
    let agents = count_direct(&root.join("agents"), "md");
    scan.service
        .stat("agents", agents.as_ref().map(|v| v.len() as u64));
    if let Some(paths) = agents {
        for path in paths {
            scan.item(5, &path, "agent", "onDemand", true, true);
        }
    }
    let installed = safe::json(&root.join("plugins/installed_plugins.json"));
    scan.service.stat(
        "pluginsInstalled",
        installed.and_then(|v| {
            v.get("plugins")
                .unwrap_or(&v)
                .as_object()
                .map(|v| v.len() as u64)
        }),
    );
    let state = safe::json(&home.join(".claude.json"));
    let usage = state.as_ref().and_then(|v| v["skillUsage"].as_object());
    scan.service
        .stat("skillUsageNames", usage.map(|v| v.len() as u64));
    scan.service.stat(
        "mcpUser",
        state.as_ref().map(|v| {
            v["mcpServers"]
                .as_object()
                .map(|v| v.len() as u64)
                .unwrap_or(0)
        }),
    );
    let project = state
        .as_ref()
        .and_then(|v| v["projects"].as_object())
        .and_then(|v| {
            v.iter()
                .find(|(p, _)| safe::normalized(Path::new(p)) == safe::normalized(cwd))
                .map(|(_, v)| v)
        });
    scan.service.stat(
        "mcpProject",
        state.as_ref().map(|_| {
            project
                .and_then(|v| v["mcpServers"].as_object())
                .map(|v| v.len() as u64)
                .unwrap_or(0)
        }),
    );
    if let Some(path) = records::latest_claude(&root, cwd) {
        scan.service.session = records::claude(&path, &own, &synced, &commands, usage);
    }
    scan.service.context.listing = scan.service.session.listing.chars;
    scan.service.context.startup = scan.service.session.startup_chars;
    scan.count_dir(
        "scripts",
        &root.join("scripts"),
        Some(SCRIPT_EXTS),
        6,
        "script",
    );
    scan.service.stat(
        "hooksDispatchBytes",
        std::fs::metadata(root.join("scripts/hooks_dispatch.py"))
            .ok()
            .map(|m| m.len()),
    );
    scan.count_dir("references", &root.join("references"), None, 7, "reference");
    scan.service.stat(
        "referencesBytes",
        safe::files(&root.join("references"), None).map(|v| {
            v.iter()
                .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
                .sum()
        }),
    );
    let tokens = safe::files(&root.join("tokens"), None);
    scan.service
        .stat("tokensFiles", tokens.as_ref().map(|v| v.len() as u64));
    scan.items.push(Item {
        id: "claude:privateCount".into(),
        service: "claude".into(),
        layer: 2,
        display_name: "privateCount".into(),
        path: None,
        kind: "privateCount".into(),
        status: "present".into(),
        size: Size {
            bytes: tokens.map(|v| {
                v.iter()
                    .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
                    .sum()
            }),
            ..Default::default()
        },
        read_timing: "private".into(),
        evidence: "measured".into(),
        modified_at: None,
        fields: vec![Field::new(
            "count",
            scan.service.stats["tokensFiles"]
                .map(|v| v.to_string())
                .unwrap_or_else(|| "unknown".into()),
        )],
        conditions: vec![],
        document_allowed: false,
        active: false,
    });
    scan.service.stat("scheduledJobs", jobs.claude);
    scan.service.stat("scheduledEnabled", jobs.claude_enabled);
    finish_context(&mut scan.service, true);
    scan
}
