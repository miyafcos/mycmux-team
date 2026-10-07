use super::{model::*, safe};
use std::collections::BTreeMap;
use std::path::Path;

fn field(item: &Item, key: &str) -> Option<String> {
    item.fields
        .iter()
        .find(|f| f.key == key)
        .map(|f| f.value.clone())
}
fn evidence(item: &Item, rule: &str) -> Evidence {
    Evidence {
        path: item.path.clone(),
        line: None,
        record: None,
        rule: rule.into(),
        fields: item.fields.clone(),
    }
}
fn base(id: &str, kind: &str, service: &str, layer: u8, severity: &str, count: u64) -> Finding {
    Finding {
        id: id.into(),
        kind: kind.into(),
        service: service.into(),
        layer,
        severity: severity.into(),
        count,
        chars: None,
        evidence: vec![],
        unknowns: vec![],
        proposal: kind.into(),
        item_ids: vec![],
        names: vec![],
    }
}
pub fn collect(catalog: &Catalog) -> Vec<Finding> {
    let mut out = vec![];
    for service in &catalog.services {
        let listing = &service.session.listing;
        if service.id == "codex" && !listing.disabled_counts.is_empty() {
            let mut f = base(
                "codex:disabledPlugins",
                "disabledPlugins",
                "codex",
                5,
                "repair",
                listing.disabled_counts.values().sum(),
            );
            f.chars = listing.disabled_chars;
            f.names = listing.disabled_counts.keys().cloned().collect();
            f.evidence.push(Evidence {
                path: Some(
                    Path::new(&service.root)
                        .join("config.toml")
                        .to_string_lossy()
                        .into(),
                ),
                line: catalog
                    .items
                    .iter()
                    .find(|i| i.service == "codex" && i.kind == "settings")
                    .and_then(|i| i.path.as_ref())
                    .and_then(|p| safe::text(Path::new(p), safe::DOCUMENT_LIMIT))
                    .and_then(|s| f.names.first().and_then(|n| safe::line_of(&s, n))),
                record: service.session.file.clone(),
                rule: "disabledButListed".into(),
                fields: service
                    .settings
                    .iter()
                    .filter(|v| {
                        v.key.starts_with("plugin:")
                            && f.names
                                .iter()
                                .any(|n| v.key.starts_with(&format!("plugin:{n}@")))
                    })
                    .cloned()
                    .collect(),
            });
            f.unknowns = vec!["pluginDisableReason".into(), "recordMayBeOlder".into()];
            f.item_ids = catalog
                .items
                .iter()
                .filter(|i| i.service == "codex" && i.kind == "settings")
                .map(|i| i.id.clone())
                .collect();
            out.push(f);
        }
        if service.id == "claude" {
            let unused: Vec<_> = listing
                .entries
                .iter()
                .filter(|s| s.usage_recorded == Some(false))
                .collect();
            if !unused.is_empty() {
                let mut f = base(
                    "claude:unusedListing",
                    "unusedListing",
                    "claude",
                    5,
                    "decide",
                    unused.len() as u64,
                );
                f.chars = Some(unused.iter().map(|s| s.chars).sum());
                f.names = unused.iter().map(|s| s.name.clone()).collect();
                f.evidence.push(Evidence {
                    path: Some(
                        Path::new(&catalog.home)
                            .join(".claude.json")
                            .to_string_lossy()
                            .into(),
                    ),
                    line: None,
                    record: service.session.file.clone(),
                    rule: "noUsageRecord".into(),
                    fields: vec![],
                });
                f.unknowns = vec!["usageStartDate".into(), "absenceIsNotNonUse".into()];
                out.push(f);
            }
        }
        if service.id == "codex" && listing.count.is_some() {
            let hidden: Vec<_> = catalog
                .items
                .iter()
                .filter(|i| {
                    i.service == "codex"
                        && i.kind == "skill"
                        && field(i, "sourceKind").as_deref() != Some("system")
                        && field(i, "allowImplicitInvocation").as_deref() == Some("false")
                        && !listing
                            .entries
                            .iter()
                            .any(|e| Some(e.name.as_str()) == field(i, "name").as_deref())
                })
                .collect();
            if !hidden.is_empty() {
                let mut f = base(
                    "codex:implicitHidden",
                    "implicitHidden",
                    "codex",
                    5,
                    "watch",
                    hidden.len() as u64,
                );
                for item in hidden {
                    f.names
                        .push(field(item, "name").unwrap_or_else(|| item.display_name.clone()));
                    f.item_ids.push(item.id.clone());
                    f.evidence.push(Evidence {
                        path: field(item, "implicitSettingPath"),
                        line: field(item, "implicitSettingLine").and_then(|s| s.parse().ok()),
                        record: service.session.file.clone(),
                        rule: "implicitInvocationDisabled".into(),
                        fields: vec![Field::new("allowImplicitInvocation", "false")],
                    });
                }
                f.unknowns = vec!["explicitInvocationStillAvailable".into()];
                out.push(f);
            }
        }
    }
    let shadows: Vec<_> = catalog
        .items
        .iter()
        .filter(|i| i.kind == "shadowedInstruction")
        .collect();
    if !shadows.is_empty() {
        let mut f = base(
            "codex:shadowedAgents",
            "shadowedAgents",
            "codex",
            3,
            "watch",
            shadows.len() as u64,
        );
        f.chars = Some(shadows.iter().filter_map(|i| i.size.chars).sum());
        for item in shadows {
            f.item_ids.push(item.id.clone());
            f.names.push(item.display_name.clone());
            f.evidence.push(evidence(item, "overridePrecedence"));
            for link in catalog
                .links
                .iter()
                .filter(|l| l.relation == "generates" && l.target_path == item.path)
            {
                f.evidence.push(Evidence {
                    path: Some(
                        Path::new(&catalog.home)
                            .join(".mycmux/agent_design/links.json")
                            .to_string_lossy()
                            .into(),
                    ),
                    line: link.line,
                    record: None,
                    rule: "declaredWriter".into(),
                    fields: vec![Field::new("script", &link.from)],
                });
            }
        }
        f.unknowns = vec!["otherReadersUnknown".into()];
        out.push(f);
    }
    for item in catalog
        .items
        .iter()
        .filter(|i| i.service == "claude" && i.kind == "memoryIndex")
    {
        if item.size.chars.is_some_and(|n| n >= 17500) || item.size.lines.is_some_and(|n| n >= 140)
        {
            let mut f = base("claude:memoryLimit", "memoryLimit", "claude", 4, "watch", 1);
            f.chars = item.size.chars;
            f.item_ids.push(item.id.clone());
            f.evidence.push(Evidence {
                path: item.path.clone(),
                line: None,
                record: None,
                rule: "memoryLimit".into(),
                fields: vec![
                    Field::new("chars", item.size.chars.unwrap_or(0)),
                    Field::new("lines", item.size.lines.unwrap_or(0)),
                    Field::new("charLimit", 25000),
                    Field::new("lineLimit", 200),
                ],
            });
            out.push(f);
        }
    }
    let mut names: BTreeMap<(String, String), Vec<&Item>> = BTreeMap::new();
    for item in catalog.items.iter().filter(|i| i.kind == "skill") {
        if let Some(name) = field(item, "name") {
            names
                .entry((item.service.clone(), name.to_lowercase()))
                .or_default()
                .push(item);
        }
        if field(item, "targetExists").as_deref() == Some("false") {
            let mut f = base(
                &format!("{}:brokenTarget:{}", item.service, item.id),
                "brokenTarget",
                &item.service,
                5,
                "repair",
                1,
            );
            f.names.push(item.display_name.clone());
            f.item_ids.push(item.id.clone());
            f.evidence.push(evidence(item, "missingWrapperTarget"));
            out.push(f);
        }
    }
    for ((service, name), items) in names {
        if items.len() > 1 {
            let mut f = base(
                &format!("{service}:duplicate:{name}"),
                "duplicate",
                &service,
                5,
                "watch",
                items.len() as u64,
            );
            f.names = vec![name];
            for item in items {
                f.item_ids.push(item.id.clone());
                f.evidence.push(evidence(item, "sameSkillName"));
            }
            out.push(f);
        }
    }
    out.sort_by_key(|f| match f.severity.as_str() {
        "repair" => 0,
        "decide" => 1,
        _ => 2,
    });
    out
}
pub fn apply_closed(catalog: &mut Catalog, closed: &Closed) {
    catalog.closed_revision = closed.revision;
    catalog.closed_count = closed
        .closed
        .iter()
        .filter(|c| {
            safe::normalized(Path::new(&c.cwd)) == safe::normalized(Path::new(&catalog.cwd))
        })
        .count() as u64;
    catalog.findings.retain(|f| {
        !closed.closed.iter().any(|c| {
            c.id == f.id
                && safe::normalized(Path::new(&c.cwd)) == safe::normalized(Path::new(&catalog.cwd))
        })
    });
}
pub fn save_close(
    directory: &Path,
    catalog: &mut Catalog,
    id: &str,
    reason: &str,
) -> Result<(), String> {
    if reason.trim().is_empty() || reason.chars().count() > 1000 {
        return Err("reasonRequired".into());
    }
    if !catalog.findings.iter().any(|f| f.id == id) {
        return Err("findingUnavailable".into());
    }
    let observed = super::closed_store::read(directory)?;
    let (closed, _) = super::closed_store::merge(
        directory,
        observed.revision,
        Closure {
            id: id.into(),
            cwd: catalog.cwd.clone(),
            reason: reason.trim().into(),
            date: chrono::Local::now().to_rfc3339(),
            closed_from: "pc".into(),
        },
    )?;
    apply_closed(catalog, &closed);
    Ok(())
}
