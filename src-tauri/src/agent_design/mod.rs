mod closed_store;
mod inspect;
mod model;
mod portable;
mod readers;
mod records;
mod safe;
mod scheduled;
mod skill_read;
#[allow(dead_code)]
mod stage1_bridge;
// Reuse stage 1's YAML/frontmatter reader without changing its source boundary.
#[path = "../skills/frontmatter.rs"]
mod frontmatter;
#[cfg(test)]
mod tests;

use crate::util::task::run_blocking;
use model::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static SNAPSHOTS: OnceLock<Mutex<BTreeMap<String, Catalog>>> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static CLAUDE_VERSION: OnceLock<Option<String>> = OnceLock::new();
static CODEX_VERSION: OnceLock<Option<String>> = OnceLock::new();
fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "homeUnavailable".into())
}
fn cwd_or_home(cwd: Option<String>, home: &Path) -> Result<PathBuf, String> {
    let path = cwd.map(PathBuf::from).unwrap_or_else(|| home.to_owned());
    if !path.is_absolute() || !path.is_dir() {
        return Err("folderUnavailable".into());
    }
    Ok(safe::canonical(&path))
}
fn state_dir(home: &Path) -> PathBuf {
    home.join(".mycmux/agent_design")
}
fn codex_root(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".codex"))
}
fn hermes_root(home: &Path) -> PathBuf {
    safe::json(&state_dir(home).join("locations.json"))
        .and_then(|v| v["hermesHome"].as_str().map(PathBuf::from))
        .filter(|p| p.is_absolute() && !safe::private(p))
        .unwrap_or_else(|| home.join(".hermes"))
}
fn cli_version(executable: &str) -> Option<String> {
    let mut command = std::process::Command::new(executable);
    command.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    text.split_whitespace()
        .find(|s| {
            s.chars().next().is_some_and(|c| c.is_ascii_digit())
                && s.chars().all(|c| c.is_ascii_digit() || ".-".contains(c))
        })
        .map(str::to_owned)
}
fn versions(home: &Path) -> (Option<String>, Option<String>) {
    let cl = if home.join(".claude").is_dir() {
        CLAUDE_VERSION.get_or_init(|| cli_version("claude")).clone()
    } else {
        None
    };
    let cx = if codex_root(home).is_dir() {
        CODEX_VERSION
            .get_or_init(|| {
                let package =
                    home.join("AppData/Roaming/npm/node_modules/@openai/codex/package.json");
                safe::json(&package)
                    .and_then(|v| v["version"].as_str().and_then(safe::identifier))
                    .or_else(|| cli_version("codex"))
            })
            .clone()
    } else {
        None
    };
    (cl, cx)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeclaredLink {
    id: String,
    event: String,
    via: String,
    script: String,
    write_path: String,
    target_service: String,
}
fn declared_links(home: &Path) -> Vec<Link> {
    let path = state_dir(home).join("links.json");
    let mut out = vec![];
    let Some(raw) = safe::text(&path, safe::DOCUMENT_LIMIT) else {
        return out;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return out;
    };
    for v in value["links"].as_array().into_iter().flatten() {
        let Ok(link) = serde_json::from_value::<DeclaredLink>(v.clone()) else {
            continue;
        };
        if !["claude", "codex", "hermes"].contains(&link.target_service.as_str()) {
            continue;
        }
        let (Some(id), Some(event), Some(via), Some(script)) = (
            safe::identifier(&link.id),
            safe::identifier(&link.event),
            safe::identifier(&link.via),
            safe::identifier(&link.script),
        ) else {
            continue;
        };
        let path = link
            .write_path
            .strip_prefix("~/")
            .map(|p| home.join(p))
            .unwrap_or_else(|| PathBuf::from(link.write_path));
        if !path.is_absolute() || safe::private(&path) || safe::private(&safe::canonical(&path)) {
            continue;
        }
        out.push(Link {
            id: format!("{id}:calls"),
            from: format!("{event} / {via}"),
            to: script.clone(),
            source_service: "claude".into(),
            target_service: "claude".into(),
            relation: "declaredCall".into(),
            evidence: "declaration".into(),
            line: safe::line_of(&raw, &script),
            target_path: None,
            exists: None,
        });
        out.push(Link {
            id,
            from: script.clone(),
            to: safe::basename(&path),
            source_service: "claude".into(),
            target_service: link.target_service,
            relation: "generates".into(),
            evidence: "declaration".into(),
            line: safe::line_of(&raw, &script),
            target_path: Some(path.to_string_lossy().into()),
            exists: Some(path.exists()),
        });
    }
    out
}
fn aggregates(catalog: &mut Catalog) {
    for service in &catalog.services {
        if service.id == "hermes" {
            continue;
        }
        let groups = [
            (1, "runtime", "outside"),
            (5, "plugins", "onDemand"),
            (5, "mcp", "onDemand"),
            (5, "skillListing", "always"),
            (6, "scheduled", "schedule"),
        ];
        for (layer, kind, timing) in groups {
            let fields = match kind {
                "runtime" => vec![
                    Field::new("version", service.version.as_deref().unwrap_or("unknown")),
                    Field::new("productInstructions", "notCounted"),
                ],
                "plugins" => service
                    .settings
                    .iter()
                    .filter(|f| f.key.starts_with("plugin:"))
                    .cloned()
                    .collect(),
                "mcp" => service
                    .settings
                    .iter()
                    .filter(|f| f.key.starts_with("mcp:"))
                    .cloned()
                    .collect(),
                "scheduled" => vec![
                    Field::new(
                        "count",
                        service
                            .stats
                            .get("scheduledJobs")
                            .copied()
                            .flatten()
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                    ),
                    Field::new(
                        "enabled",
                        service
                            .stats
                            .get("scheduledEnabled")
                            .copied()
                            .flatten()
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                    ),
                ],
                _ => vec![Field::new(
                    "count",
                    service
                        .session
                        .listing
                        .count
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "unknown".into()),
                )],
            };
            let path = match kind {
                "runtime" => Some(service.root.clone()),
                "plugins" | "mcp" => Some(
                    Path::new(&service.root)
                        .join(if service.id == "claude" {
                            "settings.json"
                        } else {
                            "config.toml"
                        })
                        .to_string_lossy()
                        .into(),
                ),
                _ => None,
            };
            catalog.items.push(Item {
                id: format!("{}:{kind}", service.id),
                service: service.id.clone(),
                layer,
                display_name: kind.into(),
                path,
                kind: kind.into(),
                status: if service.state == "absent" {
                    "absent"
                } else {
                    "present"
                }
                .into(),
                size: Size {
                    chars: if kind == "skillListing" {
                        service.session.listing.chars
                    } else {
                        None
                    },
                    ..Default::default()
                },
                read_timing: timing.into(),
                evidence: if kind == "skillListing" {
                    "measured"
                } else {
                    "declaration"
                }
                .into(),
                modified_at: None,
                fields,
                conditions: vec![],
                document_allowed: false,
                active: service.state == "present",
            });
        }
    }
}
pub(crate) fn collect(
    home: &Path,
    cwd: &Path,
    codex: &Path,
    hermes: &Path,
    jobs: &scheduled::Jobs,
    versions: (Option<String>, Option<String>),
) -> Catalog {
    let start = Instant::now();
    let scans = [
        readers::claude(home, cwd, jobs, versions.0),
        readers::codex(home, codex, cwd, jobs, versions.1),
        readers::hermes(hermes),
    ];
    let mut catalog = Catalog {
        schema_version: 1,
        generated_at: chrono::Utc::now().to_rfc3339(),
        generator: format!("mycmux/{}", env!("CARGO_PKG_VERSION")),
        work_folder: cwd.to_string_lossy().into(),
        home: home.to_string_lossy().into(),
        cwd: cwd.to_string_lossy().into(),
        refresh_ms: 0.0,
        services: vec![],
        items: vec![],
        links: declared_links(home),
        findings: vec![],
        closed_count: 0,
        warnings: vec![],
        layers: vec![],
        reading_flows: vec![],
        compare_rows: vec![],
        documents: BTreeMap::new(),
        closed_revision: 0,
    };
    for scan in scans {
        catalog.services.push(scan.service);
        catalog.items.extend(scan.items);
        catalog.links.extend(scan.links);
    }
    aggregates(&mut catalog);
    catalog.findings = inspect::collect(&catalog);
    let closed = state_dir(home).join("closed.json");
    if closed.exists() {
        if let Some(value) =
            safe::json(&closed).and_then(|v| serde_json::from_value::<Closed>(v).ok())
        {
            inspect::apply_closed(&mut catalog, &value);
        } else {
            catalog.warnings.push("closedUnsupported".into());
        }
    }
    portable::complete(&mut catalog, home, cwd);
    catalog.refresh_ms = start.elapsed().as_millis() as f64;
    catalog
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    schema_version: u8,
    contexts: Vec<Catalog>,
}
fn cached(home: &Path, cwd: &Path) -> Option<Catalog> {
    let cache = safe::json(&state_dir(home).join("cache.json"))
        .and_then(|v| serde_json::from_value::<Cache>(v).ok())?;
    if cache.schema_version != 1 {
        return None;
    }
    let mut catalog = cache.contexts.into_iter().find(|c| {
        c.schema_version == 1
            && safe::normalized(Path::new(&c.cwd)) == safe::normalized(cwd)
            && safe::normalized(Path::new(&c.home)) == safe::normalized(home)
            && !c.generator.is_empty()
            && c.work_folder == c.cwd
    })?;
    if let Ok(closed) = closed_store::read(&state_dir(home)) {
        inspect::apply_closed(&mut catalog, &closed);
    }
    Some(catalog)
}
fn save(home: &Path, catalog: &Catalog) -> Result<(), String> {
    let directory = state_dir(home);
    let mut cache = safe::json(&directory.join("cache.json"))
        .and_then(|v| serde_json::from_value::<Cache>(v).ok())
        .filter(|c| c.schema_version == 1)
        .unwrap_or_default();
    cache.contexts.retain(|c| {
        safe::normalized(Path::new(&c.cwd)) != safe::normalized(Path::new(&catalog.cwd))
    });
    cache.contexts.insert(0, catalog.clone());
    cache.contexts.truncate(8);
    cache.schema_version = 1;
    while cache.contexts.len() > 1
        && serde_json::to_vec(&cache)
            .map_err(|_| "serializationFailed")?
            .len()
            > 32 * 1024 * 1024
    {
        cache.contexts.pop();
    }
    safe::write_json(&directory, "cache.json", &cache)?;
    safe::write_json(&directory, "catalog.json", catalog)
}
fn memory_snapshot(cwd: &Path) -> Option<Catalog> {
    SNAPSHOTS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .ok()?
        .get(&safe::normalized(cwd))
        .cloned()
}
fn store(catalog: &Catalog) -> Result<(), String> {
    SNAPSHOTS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| "snapshotUnavailable")?
        .insert(safe::normalized(Path::new(&catalog.cwd)), catalog.clone());
    Ok(())
}
#[tauri::command]
pub async fn agent_design_cached(cwd: Option<String>) -> Result<Option<Catalog>, String> {
    run_blocking("agent_design_cached", move || {
        let h = home()?;
        let cwd = cwd_or_home(cwd, &h)?;
        let mut snapshot = memory_snapshot(&cwd).or_else(|| cached(&h, &cwd));
        if let (Some(catalog), Ok(closed)) = (snapshot.as_mut(), closed_store::read(&state_dir(&h)))
        {
            inspect::apply_closed(catalog, &closed);
        }
        Ok(snapshot)
    })
    .await
}
#[tauri::command]
pub async fn agent_design_refresh(cwd: Option<String>) -> Result<Catalog, String> {
    run_blocking("agent_design_refresh", move || {
        let h = home()?;
        let cwd = cwd_or_home(cwd, &h)?;
        let cx = codex_root(&h);
        let hm = hermes_root(&h);
        let start = Instant::now();
        let jobs = scheduled::collect(&h, &h.join(".claude"), &cx);
        let mut catalog = collect(&h, &cwd, &cx, &hm, &jobs, versions(&h));
        catalog.refresh_ms = start.elapsed().as_millis() as f64;
        let _guard = WRITE_LOCK.lock().map_err(|_| "stateUnavailable")?;
        if let Some(closed) = safe::json(&state_dir(&h).join("closed.json"))
            .and_then(|v| serde_json::from_value::<Closed>(v).ok())
        {
            inspect::apply_closed(&mut catalog, &closed);
        }
        save(&h, &catalog)?;
        store(&catalog)?;
        Ok(catalog)
    })
    .await
}
fn snapshot_or_cached(home: &Path, cwd: &Path) -> Result<Catalog, String> {
    memory_snapshot(cwd)
        .or_else(|| cached(home, cwd))
        .ok_or_else(|| "refreshRequired".into())
}
fn authorized(home: &Path, cwd: &Path, item: &Item) -> bool {
    let Some(path) = item.path.as_ref().map(PathBuf::from) else {
        return false;
    };
    if safe::private(&path) || safe::private(&safe::canonical(&path)) {
        return false;
    }
    let basename = safe::basename(&path);
    match item.kind.as_str() {
        "instruction" | "override" | "shadowedInstruction" => {
            (path == home.join(".claude/CLAUDE.md")
                || path == codex_root(home).join("AGENTS.md")
                || cwd.ancestors().any(|p| {
                    ["CLAUDE.md", "AGENTS.md", "AGENTS.override.md"]
                        .iter()
                        .any(|name| path == p.join(name))
                }))
        }
        "rule" => {
            path.parent() == Some(home.join(".claude/rules").as_path())
                && path.extension().is_some_and(|e| e == "md")
        }
        "reference" => {
            [".claude/references"]
                .iter()
                .any(|p| safe::canonical(&path).starts_with(safe::canonical(&home.join(p))))
                || safe::canonical(&path)
                    .starts_with(safe::canonical(&codex_root(home).join("references")))
        }
        "agent" => {
            path.parent() == Some(home.join(".claude/agents").as_path())
                && basename.ends_with(".md")
        }
        "command" => {
            safe::canonical(&path).starts_with(safe::canonical(&home.join(".claude/commands")))
                && basename.ends_with(".md")
        }
        _ => false,
    }
}
pub(crate) fn document(
    home: &Path,
    cwd: &Path,
    catalog: &Catalog,
    id: &str,
) -> Result<Value, String> {
    let item = catalog
        .items
        .iter()
        .find(|i| i.id == id)
        .ok_or("itemUnavailable")?;
    if item.path.as_ref().is_some_and(|p| {
        safe::private(Path::new(p)) || safe::private(&safe::canonical(Path::new(p)))
    }) {
        return Err("documentDenied".into());
    }
    if item.document_allowed && authorized(home, cwd, item) {
        let path = Path::new(item.path.as_deref().ok_or("itemUnavailable")?);
        let body = safe::text(path, safe::DOCUMENT_LIMIT).ok_or("documentUnavailable")?;
        Ok(json!({"id":id,"body":body,"fields":[],"size":safe::size(path,true),"status":"present"}))
    } else if !item.fields.is_empty() || !item.document_allowed {
        Ok(json!({"id":id,"body":null,"fields":item.fields,"size":item.size,"status":item.status}))
    } else {
        Err("documentDenied".into())
    }
}
#[tauri::command]
pub async fn agent_design_document(cwd: Option<String>, id: String) -> Result<Value, String> {
    run_blocking("agent_design_document", move || {
        let h = home()?;
        let cwd = cwd_or_home(cwd, &h)?;
        document(&h, &cwd, &snapshot_or_cached(&h, &cwd)?, &id)
    })
    .await
}
#[tauri::command]
pub async fn agent_design_close(
    cwd: Option<String>,
    id: String,
    reason: String,
) -> Result<Catalog, String> {
    run_blocking("agent_design_close", move || {
        let h = home()?;
        let cwd = cwd_or_home(cwd, &h)?;
        let _guard = WRITE_LOCK.lock().map_err(|_| "stateUnavailable")?;
        let mut catalog = snapshot_or_cached(&h, &cwd)?;
        inspect::save_close(&state_dir(&h), &mut catalog, &id, &reason)?;
        save(&h, &catalog)?;
        store(&catalog)?;
        Ok(catalog)
    })
    .await
}
pub(crate) fn scene(catalog: &Catalog, touched: &str) -> Value {
    let path = Path::new(touched);
    let relative = path
        .strip_prefix(Path::new(&catalog.cwd))
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let matched: Vec<_> = catalog
        .items
        .iter()
        .filter(|i| {
            i.kind == "rule"
                && i.read_timing == "conditional"
                && i.conditions.iter().any(|c| {
                    glob::Pattern::new(c).is_ok_and(|p| {
                        p.matches_with(
                            &relative,
                            glob::MatchOptions {
                                case_sensitive: !cfg!(windows),
                                require_literal_separator: false,
                                require_literal_leading_dot: false,
                            },
                        )
                    })
                })
        })
        .collect();
    let chars = matched
        .iter()
        .map(|i| i.size.chars)
        .collect::<Option<Vec<_>>>()
        .map(|v| v.iter().sum::<u64>());
    json!({"itemIds":matched.iter().map(|i|&i.id).collect::<Vec<_>>(),"chars":chars,"evidence":"declaration"})
}
#[tauri::command]
pub async fn agent_design_scene(
    cwd: Option<String>,
    touched_path: String,
) -> Result<Value, String> {
    run_blocking("agent_design_scene", move || {
        let h = home()?;
        let cwd = cwd_or_home(cwd, &h)?;
        Ok(scene(&snapshot_or_cached(&h, &cwd)?, &touched_path))
    })
    .await
}
#[tauri::command]
pub async fn agent_design_set_hermes_home(path: String) -> Result<(), String> {
    run_blocking("agent_design_set_hermes_home", move || {
        let h = home()?;
        let path = PathBuf::from(path);
        if !path.is_absolute() || safe::private(&path) {
            return Err("folderUnavailable".into());
        }
        let _guard = WRITE_LOCK.lock().map_err(|_| "stateUnavailable")?;
        safe::write_json(
            &state_dir(&h),
            "locations.json",
            &json!({"hermesHome":path}),
        )
    })
    .await
}

#[tauri::command]
pub async fn agent_design_skills(cwd: Option<String>) -> Result<Value, String> {
    run_blocking("agent_design_skills", move || {
        let h = home()?;
        let cwd = cwd_or_home(cwd, &h)?;
        let catalog = snapshot_or_cached(&h, &cwd)?;
        Ok(skill_read::catalog(&h, &catalog))
    })
    .await
}
#[tauri::command]
pub async fn agent_design_skill_read(
    cwd: Option<String>,
    action: String,
    id: String,
    relative: Option<String>,
    left: Option<usize>,
    right: Option<usize>,
) -> Result<Value, String> {
    run_blocking("agent_design_skill_read", move || {
        let h = home()?;
        let cwd = cwd_or_home(cwd, &h)?;
        let catalog = snapshot_or_cached(&h, &cwd)?;
        skill_read::read(&h, &catalog, &action, &id, relative.as_deref(), left, right)
    })
    .await
}
