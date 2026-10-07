use super::{frontmatter, model::*, safe, Catalog};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

// The stage 1 catalogue's source/placement reader, preview and sanitiser are
// compiled here as a read-only bridge. Its collect()/listing() and write APIs
// are never called from agent design.
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
    let old = safe::json(&home.join(".mycmux/skills/cache.json")).unwrap_or(Value::Null);
    let mut rows: BTreeMap<String, Value> = BTreeMap::new();
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
        let key = id.to_lowercase();
        let cached = old["skills"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(old["hiddenSkills"].as_array().into_iter().flatten())
            .find(|r| {
                r["id"]
                    .as_str()
                    .is_some_and(|s| s.eq_ignore_ascii_case(&id))
            });
        let row=rows.entry(key.clone()).or_insert_with(||{
            let description=fm["description"].as_str().unwrap_or("");
            json!({"id":key,"label":cached.and_then(|r|r["label"].as_str()).unwrap_or(&id),"description":description,"line":description.lines().next().unwrap_or(""),
                "kind":doc.kind,"plugin":doc.plugin,"category":cached.and_then(|r|r["category"].as_str()).unwrap_or("unsorted"),
                "symbol":cached.and_then(|r|r["symbol"].as_str()),"glyph":"S","agents":[],"aliases":[],"curation":"manual","isNew":false,
                "docPath":doc.path,"calls":{},"usageCount":cached.and_then(|r|r["usageCount"].as_u64()).unwrap_or(0),
                "usage":{"claude":0,"codex":0},"lastUsedAt":null,"body":"","triggers":null,
                "modifiedAt":safe::modified(&doc.path).unwrap_or(0),"fileSize":safe::size(&doc.path,false).bytes.unwrap_or(0),"codexRecorded":false})
        });
        if let Some(agents) = row["agents"].as_array_mut() {
            if !agents.iter().any(|a| a == &doc.agent) {
                agents.push(json!(doc.agent));
            }
        }
        row["calls"][&doc.agent] = json!(format!(
            "{}{}",
            if doc.agent == "claude" { "/" } else { "$" },
            id
        ));
        if doc.agent == "claude" {
            row["docPath"] = json!(doc.path);
        }
    }
    let (_, _, claude_paths) = stage1_sources(home);
    for service in &catalog.services {
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
            let row=rows.entry(key.clone()).or_insert_with(||json!({
                "id":key,"label":entry.name,"description":"","line":"","kind":kind,"plugin":entry.plugin,
                "category":"unsorted","symbol":null,"glyph":"S","agents":[],"aliases":[],"curation":"manual","isNew":false,
                "docPath":path,"calls":{},"usageCount":0,"usage":{"claude":0,"codex":0},"lastUsedAt":null,
                "body":"","triggers":null,"modifiedAt":path.as_ref().and_then(|p|safe::modified(p)).unwrap_or(0),
                "fileSize":path.as_ref().and_then(|p|safe::size(p,false).bytes).unwrap_or(0),"codexRecorded":false
            }));
            if let Some(agents) = row["agents"].as_array_mut() {
                if !agents.iter().any(|a| a == &service.id) {
                    agents.push(json!(service.id));
                }
            }
            row["calls"][&service.id] = json!(format!(
                "{}{}",
                if service.id == "claude" { "/" } else { "$" },
                entry.name
            ));
        }
    }
    let defaults: Value = serde_json::from_str(bridge::catalog::DEFAULTS).unwrap_or(Value::Null);
    let categories = old["categories"].as_array().cloned().unwrap_or_else(|| {
        defaults["categories"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    });
    json!({"generatedAt":catalog.generated_at,"categories":categories,"skills":rows.into_values().collect::<Vec<_>>(),"hiddenSkills":[],"hiddenCount":0,"newCount":0})
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
            let text = safe::text(path, safe::DOCUMENT_LIMIT).ok_or("fileUnavailable")?;
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
                &safe::text(left, safe::DOCUMENT_LIMIT).ok_or("fileUnavailable")?,
                &safe::text(right, safe::DOCUMENT_LIMIT).ok_or("fileUnavailable")?,
            ))
        }
        _ => Err("readOnly".into()),
    }
}
