use super::{frontmatter, model::*, safe, Catalog};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

// Reuse stage 1's sources, usage and curation, preview and sanitiser. Its
// collect()/listing() and write APIs are never called from agent design.
use super::stage1_bridge as bridge;
fn stage1_sources(
    home: &Path,
) -> (
    Vec<bridge::catalog::Document>,
    Vec<String>,
    BTreeMap<String, PathBuf>,
) {
    for relative in [
        ".codex/config.toml",
        ".claude/plugins/installed_plugins.json",
    ] {
        let path = home.join(relative);
        if safe::private(&path) || safe::private(&safe::canonical(&path)) {
            return (vec![], vec![], BTreeMap::new());
        }
    }
    bridge::catalog::sources(home)
}
fn sources(home: &Path, catalog: &Catalog) -> Vec<bridge::catalog::Document> {
    let (mut docs, _, _) = stage1_sources(home);
    docs.retain(|d| {
        d.agent != "hermes" && !safe::private(&d.path) && !safe::private(&safe::canonical(&d.path))
    });
    let mut known: BTreeSet<_> = docs.iter().map(|d| safe::normalized(&d.path)).collect();
    for item in catalog.items.iter().filter(|i| {
        (i.kind == "skill"
            || (i.kind == "command"
                && i.path
                    .as_deref()
                    .is_some_and(|p| safe::basename(Path::new(p)) == "SKILL.md")))
            && i.service != "hermes"
            && i.status == "present"
    }) {
        if let Some(path) = item.path.as_ref().map(PathBuf::from) {
            if known.insert(safe::normalized(&path)) {
                docs.push(bridge::catalog::Document {
                    path,
                    agent: item.service.clone(),
                    kind: if item.kind == "command" {
                        "command"
                    } else {
                        "own"
                    }
                    .into(),
                    plugin: None,
                });
            }
        }
    }
    docs
}
fn identity(path: &Path) -> Option<(String, Value, String)> {
    let text = safe::text(path, safe::DOCUMENT_LIMIT)?;
    let (fm, body) = frontmatter::split(&text);
    let id = fm["name"]
        .as_str()
        .and_then(safe::identifier)
        .unwrap_or_else(|| {
            if safe::basename(path) == "SKILL.md" {
                safe::basename(path.parent().unwrap_or(path))
            } else {
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            }
        });
    Some((id, fm, body.into()))
}
pub fn catalog(home: &Path, catalog: &Catalog) -> Value {
    let mut rows = BTreeMap::new();
    let mut places: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for doc in sources(home, catalog) {
        let Some((id, fm, _)) = identity(&doc.path) else {
            continue;
        };
        let id = if doc.kind == "command" && safe::basename(&doc.path) != "SKILL.md" {
            doc.path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        } else {
            id
        };
        bridge::catalog::add(&mut rows, &id, fm["description"].as_str().unwrap_or(""),
            &doc.agent, &doc.kind, doc.plugin.as_deref(), Some(&doc.path));
        if fm["metadata"].is_object() {
            let row = rows.get_mut(&id.to_lowercase()).unwrap();
            let mut metadata = fm["metadata"].clone();
            bridge::catalog::merge(&mut metadata, &row.metadata);
            row.metadata = metadata;
        }
        let size = safe::size(&doc.path, true);
        places.entry(id.to_lowercase()).or_default().push(json!({"service":doc.agent,"path":doc.path,
            "chars":size.chars,"lines":size.lines,"bytes":size.bytes,"modifiedAt":safe::modified(&doc.path)}));
    }
    let (_, commands, claude_paths) = stage1_sources(home);
    for name in commands {
        bridge::catalog::add(&mut rows, &name, "", "claude", "command", None, None);
    }
    for service in catalog.services.iter().filter(|s| s.id != "hermes") {
        for entry in &service.session.listing.entries {
            let key = entry.name.to_lowercase();
            let path = if service.id == "claude" {
                claude_paths.get(&key).cloned()
            } else {
                entry.path.as_ref().map(PathBuf::from)
            }
            .filter(|p| {
                p.is_file()
                    && safe::basename(p) == "SKILL.md"
                    && !safe::private(p)
                    && !safe::private(&safe::canonical(p))
            });
            let kind = match entry.kind.as_str() {
                "user" => "own",
                "system" => "builtin",
                "synced" => "plugin",
                other => other,
            };
            bridge::catalog::add(&mut rows, &entry.name, "", &service.id, kind,
                entry.plugin.as_deref(), path.as_deref());
            if let Some((_, fm, _)) = path.as_deref().and_then(identity) {
                if fm["metadata"].is_object() {
                    let row = rows.get_mut(&key).unwrap();
                    let mut metadata = fm["metadata"].clone();
                    bridge::catalog::merge(&mut metadata, &row.metadata);
                    row.metadata = metadata;
                }
            }
        }
    }
    let defaults: Value = serde_json::from_str(bridge::catalog::DEFAULTS).unwrap_or(Value::Null);
    let mut value = bridge::catalog::decorate(home, &home.join(".mycmux/skills"), defaults, rows, false);
    value["generatedAt"] = json!(catalog.generated_at);
    let claude_path = home.join(".claude.json");
    let codex_path = home.join(".mycmux/skills/usage_codex.json");
    let claude = safe::json(&claude_path);
    let codex_raw = safe::json(&codex_path);
    let state = |path: &Path, value: &Option<Value>| {
        if !path.exists() { "unavailable" }
        else if safe::private(path) || safe::private(&safe::canonical(path)) || value.as_ref().is_none_or(|v| !v.is_object()) { "failed" }
        else { "available" }
    };
    let claude_state = if claude.as_ref().is_some_and(|v| !v["skillUsage"].is_object()) { "unavailable" } else { state(&claude_path, &claude) };
    let mut codex_state = state(&codex_path, &codex_raw);
    let mut codex_usage = json!({});
    if codex_state == "available" {
        let cutoff = chrono::Utc::now().timestamp_millis() as f64 - 90.0 * 86400000.0;
        for entry in codex_raw.as_ref().and_then(Value::as_object).into_iter().flat_map(|files| files.values()) {
            let Some(mtime) = entry["mtimeNs"].as_f64().filter(|v| v.is_finite()) else { codex_state = "failed"; break; };
            let Some(skills) = entry["skills"].as_array().filter(|names| names.iter().all(Value::is_string)) else { codex_state = "failed"; break; };
            if mtime / 1_000_000.0 < cutoff { continue; }
            let names: BTreeSet<_> = skills.iter().filter_map(Value::as_str).map(str::to_lowercase).collect();
            for name in names {
                let count = codex_usage[&name]["count"].as_u64().unwrap_or(0) + 1;
                let last = [codex_usage[&name]["last"].as_f64(), entry["last"].as_f64()].into_iter().flatten().filter(|v| v.is_finite() && *v > 0.0).max_by(f64::total_cmp);
                codex_usage[&name] = json!({"count":count,"last":last});
            }
        }
    }
    // Decorate both shelves after alias/hidden curation, retaining v04's units
    // and missing/failed states without consulting or writing an old snapshot.
    for field in ["skills", "hiddenSkills"] {
        for row in value[field].as_array_mut().into_iter().flatten() {
            let key = row["id"].as_str().unwrap_or("").to_owned();
            let names: BTreeSet<_> = std::iter::once(key.clone())
                .chain(row["aliases"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_lowercase))
                .collect();
            let entries: Vec<_> = claude.as_ref().and_then(|v| v["skillUsage"].as_object())
                .into_iter().flatten().filter(|(name, _)| names.contains(&name.to_lowercase())).map(|(_, entry)| entry).collect();
            let parsed_count: Option<u64> = entries.iter().map(|entry| entry["usageCount"].as_u64()
                .or_else(|| entry["usageCount"].as_str().and_then(|value| value.parse::<u64>().ok())))
                .try_fold(0_u64, |sum, count| sum.checked_add(count?));
            let row_claude_state = if parsed_count.is_none() { "failed" } else { claude_state };
            let count = parsed_count.unwrap_or(0);
            let last_claude = if row_claude_state == "available" {
                entries.iter().filter_map(|entry| entry["lastUsedAt"].as_f64())
                    .filter(|value| value.is_finite() && *value > 0.0).max_by(f64::total_cmp)
            } else { None };
            let has_codex = row["agents"].as_array().is_some_and(|agents| agents.iter().any(|agent| agent == "codex"));
            let count_codex = if has_codex { names.iter().map(|name| codex_usage[name.as_str()]["count"].as_u64().unwrap_or(0)).sum() } else { 0 };
            let last_codex = if has_codex && codex_state == "available" {
                names.iter().filter_map(|name| codex_usage[name.as_str()]["last"].as_f64())
                    .filter(|value| value.is_finite() && *value > 0.0).max_by(f64::total_cmp)
            } else { None };
            row["places"] = json!(names.iter().flat_map(|name| places.get(name).into_iter().flatten()).collect::<Vec<_>>());
            row["usageRecords"] = json!({"sampledAt":catalog.generated_at,"claude":{"status":row_claude_state,"count":if row_claude_state=="available" {Some(count)} else {None},"lastAt":last_claude,"source":"skillUsage"},"codex":{"status":codex_state,"count":if codex_state=="available" {Some(count_codex)} else {None},"lastAt":last_codex,"source":"usage_codex.json","days":90}});
            row["usage"] = json!({"claude":count,"codex":count_codex});
            row["usageCount"] = json!(count.saturating_add(count_codex));
            row["lastUsedAt"] = json!([last_claude, last_codex].into_iter().flatten().max_by(f64::total_cmp));
            row["codexRecorded"] = json!(codex_state == "available");
            row["listedIn"] = json!({"claude":catalog.services.iter().find(|s|s.id=="claude").filter(|s| s.session.file.is_some() && s.session.listing.count.is_some()).map(|s|s.session.listing.entries.iter().any(|entry|names.contains(&entry.name.to_lowercase()))),"codex":catalog.services.iter().find(|s|s.id=="codex").filter(|s| s.session.file.is_some() && s.session.listing.count.is_some()).map(|s|s.session.listing.entries.iter().any(|entry|names.contains(&entry.name.to_lowercase())))});
        }
    }
    super::redaction::scrub(&mut value);
    value
}
pub(super) fn listed_source(home:&Path,catalog:&Catalog,path:&Path)->Option<String> {
    sources(home,catalog).into_iter().find(|doc|safe::canonical(&doc.path)==safe::canonical(path)).map(|doc|doc.agent)
}
pub(super) fn content_item(home:&Path,catalog:&Catalog,id:&str)->Option<super::model::Item> {
    let path=matching(home,catalog,id).into_iter().next()?;
    if let Some(item)=catalog.items.iter().find(|i|i.path.as_deref().is_some_and(|p|safe::normalized(Path::new(p))==safe::normalized(&path))) {return Some(item.clone());}
    let service=listed_source(home,catalog,&path).unwrap_or_else(||if path.starts_with(home.join(".claude")){"claude".into()}else{"codex".into()});
    Some(super::model::Item {id:id.into(),service,layer:5,display_name:id.into(),path:Some(path.to_string_lossy().into()),
        kind:if path.starts_with(home.join(".claude/commands")){"command"}else{"skill"}.into(),status:"present".into(),size:safe::size(&path,false),
        read_timing:"onDemand".into(),evidence:"declaration".into(),modified_at:safe::modified(&path),fields:vec![],conditions:vec![],document_allowed:false,active:true})
}
fn matching(home: &Path, catalog: &Catalog, id: &str) -> Vec<PathBuf> {
    let mut paths: Vec<_> = sources(home, catalog)
        .into_iter()
        .filter_map(|doc| {
            identity(&doc.path)
                .filter(|(name, _, _)| {
                    name.eq_ignore_ascii_case(id)
                        || (doc.kind == "command"
                            && doc
                                .path
                                .file_stem()
                                .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case(id)))
                })
                .map(|_| doc.path)
        })
        .collect();
    let (_, _, claude_paths) = stage1_sources(home);
    if let Some(path) = claude_paths.get(&id.to_lowercase()) {
        if !safe::private(path) && !safe::private(&safe::canonical(path)) {
            paths.push(path.clone());
        }
    }
    for service in &catalog.services {
        for entry in service
            .session
            .listing
            .entries
            .iter()
            .filter(|entry| entry.name.eq_ignore_ascii_case(id))
        {
            if let Some(path) = entry.path.as_ref().map(PathBuf::from).filter(|p| {
                p.is_file()
                    && safe::basename(p) == "SKILL.md"
                    && !safe::private(p)
                    && !safe::private(&safe::canonical(p))
            }) {
                paths.push(path);
            }
        }
    }
    paths.sort_by_key(|p| {
        if p.starts_with(home.join(".claude/skills")) {
            0
        } else if p.starts_with(home.join(".codex/skills")) {
            1
        } else {
            2
        }
    });
    paths.dedup();
    paths
}
fn locations(home: &Path, catalog: &Catalog, id: &str, paths: &[PathBuf]) -> Value {
    let mut items = vec![];
    let codex_count = paths
        .iter()
        .filter(|p| {
            p.starts_with(home.join(".codex/skills")) || p.starts_with(home.join(".agents/skills"))
        })
        .count();
    for (i, path) in paths.iter().enumerate() {
        let Some((_, fm, body)) = identity(path) else {
            continue;
        };
        let text = safe::text(path, safe::DOCUMENT_LIMIT).unwrap_or_default();
        let actual = catalog
            .items
            .iter()
            .find(|item| item.path.as_deref() == Some(path.to_string_lossy().as_ref()));
        let target = actual
            .and_then(|item| {
                catalog
                    .links
                    .iter()
                    .find(|l| l.from == item.id && l.relation == "readsSource")
            })
            .and_then(|l| l.target_path.clone());
        let implicit = actual
            .and_then(|i| i.fields.iter().find(|f| f.key == "allowImplicitInvocation"))
            .and_then(|f| f.value.parse::<bool>().ok());
        let plan = bridge::files::plan(path, id).ok();
        let count = plan.and_then(|v| v["files"].as_array().map(|v| v.len()));
        items.push(json!({"path":path,"folder":path.parent(),"relation":if target.is_some(){"wrapper"}else if i==0{"source"}else{"independent"},
            "modifiedAt":safe::modified(path),"lines":text.lines().count(),"fileCount":count,"allowImplicitInvocation":implicit,
            "targetExists":target.as_ref().map(|p|Path::new(p).is_file()),"target":target,
            "descriptionSame":null,"sameContent":null,"description":fm["description"],"originalDescription":fm["description"],"hash":format!("{:x}",Sha256::digest(body.as_bytes()))}));
    }
    json!({"id":id,"duplicateCodex":codex_count>1,"codexCount":codex_count,"items":items})
}
pub fn read(
    home: &Path,
    catalog: &Catalog,
    action: &str,
    id: &str,
    relative: Option<&str>,
    left: Option<usize>,
    right: Option<usize>,
) -> Result<Value, String> {
    let paths = matching(home, catalog, id);
    let path = paths.first().ok_or("skillUnavailable")?;
    match action {
        "document" => {
            use kuchikiki::traits::TendrilSink;
            let text = super::redaction::mask(&safe::text(path, safe::DOCUMENT_LIMIT).ok_or("fileUnavailable")?,false).body;
            let (fm, body) = frontmatter::split(&text);
            let html = bridge::detail::markdown(body);
            let tree = kuchikiki::parse_html().one(html.clone()).document_node;
            let toc: Vec<_> = tree
                .select("h1,h2,h3,h4,h5,h6")
                .into_iter()
                .flatten()
                .map(|heading| {
                    let level = heading.name.local.to_string()[1..]
                        .parse::<usize>()
                        .unwrap_or(1);
                    json!({"level":level,"text":heading.text_contents()})
                })
                .collect();
            Ok(
                json!({"frontmatter":fm,"body":body,"html":html,"toc":toc,"lines":text.lines().count(),
                "modifiedAt":safe::modified(path),"size":text.len()}),
            )
        }
        "locations" => Ok(locations(home, catalog, id, &paths)),
        "folder" => {
            let mut v = bridge::files::plan(path, id)?;
            if let Some(blocked) = v["blocked"].as_array_mut() {
                for (i, item) in blocked.iter_mut().enumerate() {
                    item["path"] = json!(format!("private-{i}"));
                    item["name"] = json!("private");
                }
            }
            Ok(v)
        }
        "preview" => bridge::files::preview(path, id, relative.ok_or("fileUnavailable")?),
        "diff" => {
            let left = paths
                .get(left.ok_or("fileUnavailable")?)
                .ok_or("fileUnavailable")?;
            let right = paths
                .get(right.ok_or("fileUnavailable")?)
                .ok_or("fileUnavailable")?;
            Ok(bridge::detail::diff(
                &super::redaction::mask(&safe::text(left, safe::DOCUMENT_LIMIT).ok_or("fileUnavailable")?,false).body,
                &super::redaction::mask(&safe::text(right, safe::DOCUMENT_LIMIT).ok_or("fileUnavailable")?,false).body,
            ))
        }
        _ => Err("readOnly".into()),
    }
}
