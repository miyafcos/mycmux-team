use super::{files, frontmatter};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const DEFAULTS: &str = include_str!("defaults.json");
pub const GUESSES: &str = include_str!("guess.json");
pub fn text(path: &Path) -> String {
    if files::private_path(path) || files::private_path(&canonical(path)) {
        return String::new();
    }
    fs::read_to_string(path)
        .unwrap_or_default()
        .trim_start_matches('\u{feff}')
        .to_owned()
}
pub fn read_json(path: &Path) -> Value {
    serde_json::from_str(&text(path)).unwrap_or_else(|_| json!({}))
}
pub fn children(path: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<_> = fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .collect();
    paths.sort_by_key(|p| (filename(p).to_lowercase(), filename(p)));
    paths
}
fn filename(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
pub fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_owned())
}
pub fn mtime(path: &Path) -> f64 {
    fs::metadata(path)
        .and_then(|s| s.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}
pub fn merge(base: &mut Value, overlay: &Value) {
    if let (Some(a), Some(b)) = (base.as_object_mut(), overlay.as_object()) {
        for (key, value) in b {
            merge(a.entry(key).or_insert(Value::Null), value);
        }
    } else {
        *base = overlay.clone();
    }
}
fn layer(mut value: Value) -> Value {
    for key in ["skills", "aliases"] {
        if let Some(map) = value[key].as_object() {
            value[key] = Value::Object(
                map.iter()
                    .map(|(k, v)| (k.to_lowercase(), v.clone()))
                    .collect(),
            );
        }
    }
    value
}

#[derive(Clone)]
pub struct Document {
    pub path: PathBuf,
    pub agent: String,
    pub kind: String,
    pub plugin: Option<String>,
}
fn doc(path: PathBuf, agent: &str, kind: &str, plugin: Option<&str>) -> Document {
    Document {
        path,
        agent: agent.to_owned(),
        kind: kind.to_owned(),
        plugin: plugin.map(str::to_owned),
    }
}
pub fn sources(home: &Path) -> (Vec<Document>, Vec<String>, BTreeMap<String, PathBuf>) {
    let mut docs = Vec::new();
    let mut commands = Vec::new();
    let mut claude_docs: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for (relative, agent) in [
        (".claude", "claude"),
        (".agents", "codex"),
        (".codex", "codex"),
        (".hermes", "hermes"),
    ] {
        for folder in children(&home.join(relative).join("skills")) {
            let name = filename(&folder);
            if name.starts_with(['_', '.'])
                || name.to_lowercase().contains("backup")
                || (relative == ".claude" && name == "synced")
            {
                continue;
            }
            let path = folder.join("SKILL.md");
            if path.is_file() {
                docs.push(doc(path, agent, "own", None));
            }
        }
    }
    for path in children(&home.join(".claude/commands")) {
        if path.is_file() && path.extension().is_some_and(|e| e == "md") {
            docs.push(doc(path, "claude", "command", None));
        } else if path.is_dir() {
            commands.push(filename(&path));
        }
    }
    for folder in children(&home.join(".codex/skills/.system")) {
        let path = folder.join("SKILL.md");
        if path.is_file() {
            docs.push(doc(path, "codex", "builtin", None));
        }
    }
    let config = text(&home.join(".codex/config.toml"))
        .parse::<toml_edit::DocumentMut>()
        .ok();
    if let Some(config) = config {
        let personal = config
            .get("marketplaces")
            .and_then(|i| i.get("personal"))
            .and_then(|i| i.get("source"))
            .and_then(|i| i.as_str())
            .map(|s| PathBuf::from(s.trim_start_matches("\\\\?\\")));
        if let Some(plugins) = config.get("plugins").and_then(|i| i.as_table_like()) {
            for (key, setting) in plugins.iter() {
                if setting.get("enabled").and_then(|i| i.as_bool()) != Some(true) {
                    continue;
                }
                let (plugin, market) = key.split_once('@').unwrap_or((key, ""));
                let roots = if market == "openai-primary-runtime" {
                    vec![home.join(".cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime/plugins").join(plugin).join("skills")]
                } else if market == "personal" {
                    personal
                        .as_ref()
                        .map(|p| {
                            glob::glob(&format!(
                                "{}/**/{}/skills",
                                p.to_string_lossy().replace('\\', "/"),
                                plugin
                            ))
                            .into_iter()
                            .flatten()
                            .flatten()
                            .collect()
                        })
                        .unwrap_or_default()
                } else {
                    let mut versions: Vec<_> =
                        children(&home.join(".codex/plugins/cache").join(market).join(plugin))
                            .into_iter()
                            .filter(|p| p.is_dir())
                            .collect();
                    versions.sort_by(|a, b| mtime(b).total_cmp(&mtime(a)).then_with(|| b.cmp(a)));
                    versions
                        .into_iter()
                        .take(1)
                        .map(|p| p.join("skills"))
                        .collect()
                };
                for root in roots {
                    let mut paths = BTreeSet::new();
                    for child in children(&root) {
                        if child.join("SKILL.md").is_file() {
                            paths.insert(child.join("SKILL.md"));
                        }
                        for nested in children(&child) {
                            if nested.join("SKILL.md").is_file() {
                                paths.insert(nested.join("SKILL.md"));
                            }
                        }
                    }
                    for path in paths {
                        docs.push(doc(path, "codex", "plugin", Some(plugin)));
                    }
                }
            }
        }
    }
    for group in children(&home.join(".claude/skills/synced")) {
        for folder in children(&group) {
            let path = folder.join("SKILL.md");
            if path.is_file() {
                claude_docs
                    .entry(format!(
                        "anthropic-skills:{}",
                        filename(&folder).to_lowercase()
                    ))
                    .or_default()
                    .push(path);
            }
        }
    }
    let synced: BTreeSet<_> = claude_docs.keys().cloned().collect();
    let installed = read_json(&home.join(".claude/plugins/installed_plugins.json"));
    if let Some(plugins) = installed["plugins"].as_object() {
        for (key, entries) in plugins {
            let plugin = key.split('@').next().unwrap_or(key);
            for entry in entries.as_array().into_iter().flatten() {
                if entry["scope"] != "user"
                    && !(entry["scope"] == "project"
                        && entry["projectPath"]
                            .as_str()
                            .is_some_and(|s| canonical(Path::new(s)) == canonical(home)))
                {
                    continue;
                }
                let Some(install) = entry["installPath"].as_str() else {
                    continue;
                };
                for folder in children(&Path::new(install).join("skills")) {
                    let path = folder.join("SKILL.md");
                    let key = format!("{}:{}", plugin, filename(&folder)).to_lowercase();
                    if path.is_file() && !synced.contains(&key) {
                        claude_docs.entry(key).or_default().push(path);
                    }
                }
            }
        }
    }
    let claude_docs = claude_docs
        .into_iter()
        .filter_map(|(key, mut paths)| {
            paths.sort_by(|a, b| mtime(b).total_cmp(&mtime(a)).then_with(|| b.cmp(a)));
            paths.into_iter().next().map(|p| (key, p))
        })
        .collect();
    (docs, commands, claude_docs)
}

fn listing(home: &Path, shared: &Path) -> BTreeMap<String, (String, String)> {
    let root = home.join(".claude/projects");
    let project: String = home
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let exact = root.join(project);
    let folders = if exact.is_dir() {
        vec![exact]
    } else {
        children(&root)
    };
    let cutoff = chrono::Utc::now().timestamp() as f64 - 7.0 * 86400.0;
    let mut candidates: Vec<_> = folders
        .into_iter()
        .flat_map(|p| children(&p))
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl") && mtime(p) >= cutoff)
        .collect();
    candidates.sort_by(|a, b| mtime(b).total_cmp(&mtime(a)).then_with(|| b.cmp(a)));
    let mut result: BTreeMap<String, (String, String)> = BTreeMap::new();
    for path in candidates.into_iter().take(10) {
        let mut prefix = Vec::new();
        if let Ok(f) = fs::File::open(path) {
            let _ = f.take(4 * 1024 * 1024).read_to_end(&mut prefix);
        }
        for line in prefix.split(|b| *b == b'\n') {
            let Ok(row) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if row["type"] != "attachment" || row["attachment"]["type"] != "skill_listing" {
                continue;
            }
            let attachment = &row["attachment"];
            let names: Vec<_> = attachment["names"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let content = attachment["content"].as_str().unwrap_or("");
            let chunks: Vec<_> = content.split("\n- ").collect();
            for (at, chunk) in chunks.into_iter().enumerate() {
                let chunk = if at == 0 {
                    let Some(c) = chunk.strip_prefix("- ") else {
                        continue;
                    };
                    c
                } else {
                    chunk
                };
                let (name, description) = chunk.split_once(": ").unwrap_or((chunk, ""));
                let name = name.trim();
                if !names.contains(&name)
                    && !name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_:-".contains(c))
                {
                    continue;
                }
                if name.is_empty() {
                    continue;
                }
                let desc = description.split_whitespace().collect::<Vec<_>>().join(" ");
                let entry = result
                    .entry(name.to_lowercase())
                    .or_insert((name.to_owned(), String::new()));
                if entry.1.is_empty() {
                    entry.1 = desc;
                }
            }
            for name in names {
                result
                    .entry(name.to_lowercase())
                    .or_insert((name.to_owned(), String::new()));
            }
        }
    }
    // The phone keeps recently observed built-ins for 30 days. A shared cache
    // may supply the same retention without reading entire conversations.
    let seen = read_json(&shared.join("skill_listing_seen.json"));
    if let Some(seen) = seen.as_object() {
        for (name, value) in seen {
            if value["lastSeen"].as_f64().unwrap_or(0.0) >= cutoff - 23.0 * 86400.0 {
                result.entry(name.to_lowercase()).or_insert((
                    name.clone(),
                    value["description"].as_str().unwrap_or("").to_owned(),
                ));
            }
        }
    }
    result
}

pub fn short_line(description: &str) -> String {
    let mut end = description.len();
    for (at, ch) in description.char_indices() {
        if ch == '\u{3002}' || (ch == '.' && description[at + 1..].starts_with(char::is_whitespace))
        {
            end = at + ch.len_utf8();
            break;
        }
    }
    let mut line = description[..end].to_owned();
    // Keep the label of a Markdown link, discard its destination.
    while let Some(start) = line.find('[') {
        let Some(mid) = line[start..].find("](").map(|i| start + i) else {
            break;
        };
        let Some(close) = line[mid + 2..].find(')').map(|i| mid + 2 + i) else {
            break;
        };
        let label = line[start + 1..mid].to_owned();
        line.replace_range(start..=close, &label);
    }
    let line: String = line
        .chars()
        .filter(|c| !"`*_#>[]\"'".contains(*c))
        .collect::<String>()
        .trim()
        .to_owned();
    if line.chars().count() > 40 {
        format!("{}\u{2026}", line.chars().take(39).collect::<String>())
    } else {
        line
    }
}

pub(crate) struct Row {
    value: Value,
    documents: Vec<(u8, PathBuf)>,
    pub(crate) metadata: Value,
    agents: BTreeSet<String>,
}
pub(crate) fn add(
    rows: &mut BTreeMap<String, Row>,
    name: &str,
    description: &str,
    agent: &str,
    kind: &str,
    plugin: Option<&str>,
    path: Option<&Path>,
) {
    let name = name.trim();
    if name.is_empty() {
        return;
    }
    let row = rows.entry(name.to_lowercase()).or_insert_with(|| Row {
        value: json!({"id":name,"description":"","kind":kind,"plugin":plugin,"aliases":[]}),
        documents: vec![],
        metadata: json!({}),
        agents: BTreeSet::new(),
    });
    row.agents.insert(agent.to_owned());
    if row.value["description"] == "" && !description.is_empty() {
        row.value["description"] =
            json!(description.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    let rank = |k: &str| {
        ["own", "command", "builtin", "plugin"]
            .iter()
            .position(|v| *v == k)
            .unwrap_or(4)
    };
    if rank(kind) < rank(row.value["kind"].as_str().unwrap_or("")) {
        row.value["kind"] = json!(kind);
        row.value["plugin"] = json!(plugin);
    }
    if let Some(path) = path {
        let priority = if agent == "claude" && kind == "own" {
            0
        } else if agent == "codex" {
            1
        } else if kind == "command" {
            2
        } else {
            3
        };
        row.documents.push((priority, path.to_owned()));
    }
}

pub fn usage(shared: &Path) -> (Value, bool) {
    usage_at(shared, chrono::Utc::now().timestamp_millis() as f64)
}
pub(super) fn usage_at(shared: &Path, now_ms: f64) -> (Value, bool) {
    let path = shared.join("usage_codex.json");
    let exists = path.exists();
    let ledger = read_json(&path);
    let mut out = json!({});
    if let Some(files) = ledger.as_object() {
        let cutoff = now_ms - 90.0 * 86400000.0;
        for entry in files.values() {
            if entry["mtimeNs"].as_f64().unwrap_or(0.0) / 1_000_000.0 < cutoff {
                continue;
            }
            let names: BTreeSet<_> = entry["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            for name in names {
                let count = out[name]["count"].as_i64().unwrap_or(0) + 1;
                let last = out[name]["last"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .max(entry["last"].as_f64().unwrap_or(0.0));
                out[name] = json!({"count":count,"last":if last>0.0 {Some(last)} else {None}});
            }
        }
    }
    (out, exists)
}

pub fn collect(home: &Path, shared: &Path, shipped: Value) -> Value {
    let (docs, commands, claude_docs) = sources(home);
    let mut rows = BTreeMap::new();
    for document in docs {
        let content = text(&document.path);
        let (fm, _) = frontmatter::split(&content);
        let name = if document.kind == "command" {
            document
                .path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        } else {
            fm["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&filename(document.path.parent().unwrap()))
                .to_owned()
        };
        add(
            &mut rows,
            &name,
            fm["description"].as_str().unwrap_or(""),
            &document.agent,
            &document.kind,
            document.plugin.as_deref(),
            Some(&document.path),
        );
        if fm["metadata"].is_object() {
            let row = rows.get_mut(&name.to_lowercase()).unwrap();
            let mut meta = fm["metadata"].clone();
            merge(&mut meta, &row.metadata);
            row.metadata = meta;
        }
    }
    for name in commands {
        add(&mut rows, &name, "", "claude", "command", None, None);
    }
    for (key, (name, description)) in listing(home, shared) {
        if let Some(row) = rows.get_mut(&key) {
            row.agents.insert("claude".to_owned());
        } else {
            add(
                &mut rows,
                &name,
                &description,
                "claude",
                if name.contains(':') {
                    "plugin"
                } else {
                    "builtin"
                },
                name.split_once(':').map(|v| v.0),
                None,
            );
        }
    }
    for (key, path) in claude_docs {
        if let Some(row) = rows.get_mut(&key).filter(|r| r.agents.contains("claude")) {
            row.documents.push((3, path.clone()));
            let content = text(&path);
            let (fm, _) = frontmatter::split(&content);
            if fm["metadata"].is_object() {
                let mut meta = fm["metadata"].clone();
                merge(&mut meta, &row.metadata);
                row.metadata = meta;
            }
        }
    }
    decorate(home, shared, shipped, rows, true)
}

/// Apply the shared usage, aliases and curation rules to already known sources.
/// Read-only hosts pass false to keep bodies out of their catalogue and never
/// scan transcripts or write the stage 1 snapshot.
pub(crate) fn decorate(
    home: &Path,
    shared: &Path,
    shipped: Value,
    mut rows: BTreeMap<String, Row>,
    include_body: bool,
) -> Value {
    let shipped = layer(shipped);
    let manual = layer(read_json(&shared.join("shelf.json")));
    let automatic = layer(read_json(&shared.join("shelf_auto.json")));
    let mut settings = shipped.clone();
    merge(&mut settings, &manual);
    let mut categories = settings["categories"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !categories.iter().any(|c| c["id"] == "unsorted") {
        categories.push(json!({"id":"unsorted","name":"\u{672a}\u{5206}\u{985e}","color":"#8E8E93","symbol":"questionmark.folder"}));
    }
    let claude = read_json(&home.join(".claude.json"));
    let usage_claude: BTreeMap<_, _> = claude["skillUsage"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.to_lowercase(), v))
        .collect();
    let (codex, codex_recorded) = usage(shared);
    for (key, row) in &mut rows {
        let entry = usage_claude.get(key).copied().unwrap_or(&Value::Null);
        let count = entry["usageCount"]
            .as_i64()
            .or_else(|| entry["usageCount"].as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(0);
        let codex_count = if row.agents.contains("codex") {
            codex[key]["count"].as_i64().unwrap_or(0)
        } else {
            0
        };
        let last = [
            entry["lastUsedAt"].as_f64(),
            if row.agents.contains("codex") {
                codex[key]["last"].as_f64()
            } else {
                None
            },
        ]
        .into_iter()
        .flatten()
        .max_by(f64::total_cmp);
        row.value["usage"] = json!({"claude":count,"codex":codex_count});
        row.value["usageCount"] = json!(count + codex_count);
        row.value["lastUsedAt"] = json!(last);
    }
    let hidden: BTreeSet<_> = settings["hidden"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_lowercase)
        .collect();
    let hidden_count = rows.keys().filter(|k| hidden.contains(*k)).count();
    // Keep hidden rows in a separate list for the PC's read-only hidden shelf.
    let mut hidden_rows = BTreeMap::new();
    for key in &hidden {
        if let Some(row) = rows.remove(key) {
            hidden_rows.insert(key.clone(), row);
        }
    }
    if let Some(aliases) = settings["aliases"].as_object() {
        for (alias, target) in aliases {
            let target = target.as_str().unwrap_or("").to_lowercase();
            if alias == &target || !rows.contains_key(alias) || !rows.contains_key(&target) {
                continue;
            }
            let source = rows.remove(alias).unwrap();
            let destination = rows.get_mut(&target).unwrap();
            destination.value["aliases"]
                .as_array_mut()
                .unwrap()
                .push(source.value["id"].clone());
            for field in ["usageCount"] {
                destination.value[field] = json!(
                    destination.value[field].as_i64().unwrap_or(0)
                        + source.value[field].as_i64().unwrap_or(0)
                );
            }
            for agent in ["claude", "codex"] {
                destination.value["usage"][agent] = json!(
                    destination.value["usage"][agent].as_i64().unwrap_or(0)
                        + source.value["usage"][agent].as_i64().unwrap_or(0)
                );
            }
            destination.value["lastUsedAt"] = json!([
                destination.value["lastUsedAt"].as_f64(),
                source.value["lastUsedAt"].as_f64()
            ]
            .into_iter()
            .flatten()
            .max_by(f64::total_cmp));
            destination.agents.extend(source.agents);
        }
    }
    let guesses: Value = serde_json::from_str(GUESSES).unwrap();
    let decorate = |(key, mut row): (String, Row)| {
        let id = row.value["id"].as_str().unwrap().to_owned();
        let description = row.value["description"].as_str().unwrap_or("").to_owned();
        let short = row.metadata["short-description"].as_str().unwrap_or("");
        let search = format!("{} {} {}", id, description, short).to_lowercase();
        let scores: Vec<_> = categories
            .iter()
            .filter(|c| c["id"] != "unsorted")
            .map(|c| {
                let cat = c["id"].as_str().unwrap_or("");
                let score: usize = guesses[cat]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|w| search.matches(&w.to_lowercase()).count())
                    .sum();
                (cat, score)
            })
            .collect();
        let best = scores.iter().map(|(_, n)| *n).max().unwrap_or(0);
        let winners: Vec<_> = scores
            .iter()
            .filter(|(_, n)| *n == best)
            .map(|(c, _)| *c)
            .collect();
        let cat = if best > 0 && winners.len() == 1 {
            winners[0]
        } else {
            "unsorted"
        };
        row.value["category"] = json!(cat);
        row.value["label"] = json!(if !short.is_empty() && short.chars().count() <= 16 {
            short
        } else {
            &id
        });
        row.value["glyph"] = json!(id.chars().next().unwrap_or('?').to_uppercase().to_string());
        row.value["line"] = json!(short_line(&description));
        row.value["symbol"] = categories
            .iter()
            .find(|c| c["id"] == cat)
            .map(|c| c["symbol"].clone())
            .unwrap_or(Value::Null);
        let mut curation = "guess";
        let mut reviewed = false;
        for (origin, definition) in [
            ("auto", &automatic["skills"][&key]),
            ("shipped", &shipped["skills"][&key]),
            ("skill", &row.metadata["pocket"]),
            ("manual", &manual["skills"][&key]),
        ] {
            if !definition.is_object() {
                continue;
            }
            if origin != "auto" {
                reviewed = true;
            }
            for field in ["category", "label", "glyph", "line", "symbol"] {
                if origin == "skill" && field == "glyph" {
                    continue;
                }
                if definition
                    .get(field)
                    .is_some_and(|v| v.is_string() || (field == "symbol" && v.is_null()))
                {
                    row.value[field] = definition[field].clone();
                    if field == "category" {
                        curation = origin;
                    }
                }
            }
        }
        row.value["curation"] = json!(curation);
        row.value["isNew"] = json!(!reviewed);
        if !categories.iter().any(|c| c["id"] == row.value["category"]) {
            row.value["category"] = json!("unsorted");
        }
        let agents: Vec<_> = ["claude", "codex", "hermes"]
            .into_iter()
            .filter(|a| row.agents.contains(*a))
            .collect();
        row.value["agents"] = json!(agents);
        let calls: Map<_, _> = [("claude", "/"), ("codex", "$")]
            .into_iter()
            .filter(|(a, _)| row.agents.contains(*a))
            .map(|(a, p)| (a.to_owned(), json!(format!("{p}{id}"))))
            .collect();
        row.value["calls"] = json!(calls);
        row.value["duplicateCodex"] = json!(
            row.documents
                .iter()
                .filter(|(priority, _)| *priority == 1)
                .map(|(_, path)| path)
                .collect::<BTreeSet<_>>()
                .len()
                > 1
        );
        row.value["hasWrapper"] = json!(include_body && row.documents.iter().any(|(_, path)| {
            let value = text(path);
            let (_, body) = frontmatter::split(&value);
            body.trim_start()
                .trim_start_matches(['#', ' '])
                .starts_with("Compatibility wrapper")
        }));
        row.documents.sort_by_key(|(p, _)| *p);
        let path = row.documents.first().map(|(_, p)| canonical(p));
        row.value["docPath"] = json!(path
            .as_ref()
            .filter(|p| !files::private_path(p))
            .map(|p| p.to_string_lossy().into_owned()));
        row.value["triggers"] = row.metadata["triggers"].clone();
        row.value["codexRecorded"] = json!(codex_recorded);
        row.value["body"] = json!("");
        if let Some(path) = path.filter(|p| !files::private_path(p)) {
            if include_body {
                let content = text(&path);
                let (_, body) = frontmatter::split(&content);
                row.value["body"] = json!(body);
            }
            row.value["modifiedAt"] = json!(mtime(&path) * 1000.0);
            row.value["fileSize"] = json!(fs::metadata(&path).map(|m| m.len()).unwrap_or(0));
        } else {
            row.value["modifiedAt"] = json!(0);
            row.value["fileSize"] = json!(0);
        }
        row.value
    };
    let mut skills: Vec<_> = rows.into_iter().map(|(k, r)| decorate((k, r))).collect();
    let order = |v: &Value| {
        categories
            .iter()
            .position(|c| c["id"] == v["category"])
            .unwrap_or(categories.len())
    };
    skills.sort_by(|a, b| {
        order(a)
            .cmp(&order(b))
            .then_with(|| b["usageCount"].as_i64().cmp(&a["usageCount"].as_i64()))
            .then_with(|| {
                (!["own", "command"].contains(&a["kind"].as_str().unwrap_or("")))
                    .cmp(&(!["own", "command"].contains(&b["kind"].as_str().unwrap_or(""))))
            })
            .then_with(|| a["label"].as_str().cmp(&b["label"].as_str()))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let hidden_skills: Vec<_> = hidden_rows
        .into_iter()
        .map(|(k, r)| decorate((k, r)))
        .collect();
    let new_count = skills.iter().filter(|s| s["isNew"] == true).count();
    json!({"generatedAt":chrono::Utc::now().to_rfc3339(),"categories":categories,"skills":skills,"hiddenCount":hidden_count,"newCount":new_count,"hiddenSkills":hidden_skills})
}
