mod claude;
mod codex;
mod hermes;
use super::{frontmatter, model::*, records, safe, scheduled::Jobs};
pub use claude::read as claude;
pub use codex::read as codex;
pub use hermes::read as hermes;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub const SCRIPT_EXTS: &[&str] = &["py", "ps1", "sh", "js", "mjs", "cjs", "ts", "cmd", "bat"];
pub struct Scan {
    pub service: Service,
    pub items: Vec<Item>,
    pub links: Vec<Link>,
}
impl Scan {
    fn new(id: &str, label: &str, root: &Path) -> Self {
        Self {
            service: Service::new(id, label, root),
            items: vec![],
            links: vec![],
        }
    }
    fn item(
        &mut self,
        layer: u8,
        path: &Path,
        kind: &str,
        timing: &str,
        read: bool,
        allowed: bool,
    ) -> Option<usize> {
        if safe::private(path) || safe::private(&safe::canonical(path)) {
            return None;
        }
        let exists = path.exists();
        self.items.push(Item {
            id: format!("{}:{}:{}", self.service.id, kind, path.to_string_lossy()),
            service: self.service.id.clone(),
            layer,
            display_name: safe::basename(path),
            path: Some(path.to_string_lossy().into()),
            kind: kind.into(),
            status: if exists { "present" } else { "absent" }.into(),
            size: safe::size(path, read),
            read_timing: timing.into(),
            evidence: "declaration".into(),
            modified_at: safe::modified(path),
            fields: vec![],
            conditions: vec![],
            document_allowed: exists && allowed,
            active: exists,
        });
        Some(self.items.len() - 1)
    }
    fn count_dir(&mut self, key: &str, path: &Path, exts: Option<&[&str]>, layer: u8, kind: &str) {
        let files = safe::files(path, exts);
        self.service
            .stat(key, files.as_ref().map(|v| v.len() as u64));
        if let Some(files) = files {
            for p in files {
                self.item(
                    layer,
                    &p,
                    kind,
                    "onDemand",
                    false,
                    kind == "reference" && p.extension().is_some_and(|e| e == "md"),
                );
            }
        }
    }
}
fn count_direct(root: &Path, ext: &str) -> Option<Vec<PathBuf>> {
    Some(
        safe::children(root)?
            .into_iter()
            .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == ext) && !safe::private(p))
            .collect(),
    )
}
fn hooks(value: &Value, source: &Path, raw: &str) -> Vec<Hook> {
    let mut out = vec![];
    let hooks = value.get("hooks").unwrap_or(value);
    if let Some(events) = hooks.as_object() {
        for (event, groups) in events {
            let Some(event) = safe::identifier(event) else {
                continue;
            };
            for group in groups.as_array().into_iter().flatten() {
                let matcher = group["matcher"]
                    .as_str()
                    .and_then(safe::identifier)
                    .unwrap_or_default();
                let handlers: Vec<_> = group["hooks"]
                    .as_array()
                    .map(|h| h.iter().collect())
                    .unwrap_or_else(|| vec![group]);
                for h in handlers {
                    let script = safe::script_name(h["command"].as_str().unwrap_or(""));
                    out.push(Hook {
                        event: event.clone(),
                        matcher: matcher.clone(),
                        script: script.clone(),
                        source: source.to_string_lossy().into(),
                        line: safe::line_of(raw, &script),
                    });
                }
            }
        }
    }
    out
}
fn add_hook_links(scan: &mut Scan, known: bool) {
    let source = Path::new(&scan.service.root).join(if scan.service.id == "claude" {
        "settings.json"
    } else {
        "hooks.json"
    });
    if let Some(idx) = scan.item(6, &source, "hooks", "event", false, false) {
        if source.exists() && !known {
            scan.items[idx].status = "unknown".into();
        }
        scan.items[idx].fields = scan
            .service
            .hooks
            .iter()
            .flat_map(|h| {
                [
                    Field::new(&format!("hook:{}", h.event), &h.script),
                    Field::new("matcher", &h.matcher),
                ]
            })
            .collect();
    }
    for (i, h) in scan.service.hooks.iter().enumerate() {
        scan.links.push(Link {
            id: format!("{}:hook:{i}", scan.service.id),
            from: h.event.clone(),
            to: h.script.clone(),
            source_service: scan.service.id.clone(),
            target_service: scan.service.id.clone(),
            relation: "executes".into(),
            evidence: "declaration".into(),
            line: h.line,
            target_path: None,
            exists: None,
        });
    }
    scan.service.stat(
        "hookEvents",
        known.then(|| {
            scan.service
                .hooks
                .iter()
                .map(|h| h.event.clone())
                .collect::<BTreeSet<_>>()
                .len() as u64
        }),
    );
    scan.service.stat(
        "hookHandlers",
        known.then_some(scan.service.hooks.len() as u64),
    );
}
fn safe_scalar(value: &Value) -> Option<String> {
    value.as_str().and_then(safe::identifier)
}
fn load_stage1(home: &Path) -> BTreeMap<String, (String, String)> {
    // Reuse the existing stage 1 catalogue identities, without its broader
    // transcript refresh or its body / description / custom metadata fields.
    let mut map = BTreeMap::new();
    if let Some(catalog) = safe::json(&home.join(".mycmux/skills/cache.json")) {
        for row in catalog["skills"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(catalog["hiddenSkills"].as_array().into_iter().flatten())
        {
            if let (Some(path), Some(id)) = (row["docPath"].as_str(), row["id"].as_str()) {
                if !safe::private(Path::new(path)) {
                    map.insert(
                        safe::normalized(Path::new(path)),
                        (id.into(), row["label"].as_str().unwrap_or(id).into()),
                    );
                }
            }
        }
    }
    map
}
fn skill(
    scan: &mut Scan,
    path: &Path,
    cache: &BTreeMap<String, (String, String)>,
    home: &Path,
) -> Option<String> {
    let text = match safe::text(path, safe::DOCUMENT_LIMIT) {
        Some(text) => text,
        None => {
            if let Some(index) = scan.item(5, path, "skill", "onDemand", false, false) {
                scan.items[index].status = "unknown".into();
                scan.items[index].fields.push(Field::new("unsupported", 1));
            }
            return None;
        }
    };
    let (fm, body) = frontmatter::split(&text);
    let name = fm["name"]
        .as_str()
        .and_then(safe::identifier)
        .unwrap_or_else(|| safe::basename(path.parent().unwrap_or(path)));
    let idx = scan.item(5, path, "skill", "onDemand", true, false)?;
    let item = &mut scan.items[idx];
    item.fields.push(Field::new(
        "sourceKind",
        if path.components().any(|c| c.as_os_str() == ".system") {
            "system"
        } else {
            "own"
        },
    ));
    item.display_name = cache
        .get(&safe::normalized(path))
        .map(|(_, label)| label.clone())
        .unwrap_or_else(|| name.clone());
    item.fields.push(Field::new("name", &name));
    if let Some((id, _)) = cache.get(&safe::normalized(path)) {
        item.fields.push(Field::new("catalogId", id));
    }
    let yaml = path.parent()?.join("agents/openai.yaml");
    if let Some(text) = safe::text(&yaml, safe::DOCUMENT_LIMIT) {
        if let Some(allow) =
            frontmatter::parse(&text)["policy"]["allow_implicit_invocation"].as_bool()
        {
            item.fields
                .push(Field::new("allowImplicitInvocation", allow));
            item.fields
                .push(Field::new("implicitSettingPath", yaml.to_string_lossy()));
            if let Some(line) = safe::line_of(&text, "allow_implicit_invocation") {
                item.fields.push(Field::new("implicitSettingLine", line));
            }
        }
    }
    if body.contains("Compatibility wrapper") {
        for (i, chunk) in body.split(char::from(96)).enumerate() {
            if i % 2 == 1 && chunk.to_lowercase().ends_with("skill.md") {
                let raw = chunk.replace('\\', "/");
                let target = raw
                    .strip_prefix("~/")
                    .map(|rel| home.join(rel))
                    .unwrap_or_else(|| PathBuf::from(&raw));
                if target.is_absolute()
                    && !safe::private(&target)
                    && !safe::private(&safe::canonical(&target))
                {
                    item.fields
                        .push(Field::new("targetExists", target.is_file()));
                    scan.links.push(Link {
                        id: format!("wrapper:{}", item.id),
                        from: item.id.clone(),
                        to: safe::basename(&target),
                        source_service: scan.service.id.clone(),
                        target_service: if target.starts_with(home.join(".claude")) {
                            "claude"
                        } else {
                            &scan.service.id
                        }
                        .into(),
                        relation: "readsSource".into(),
                        evidence: "declaration".into(),
                        line: None,
                        target_path: Some(target.to_string_lossy().into()),
                        exists: Some(target.is_file()),
                    });
                    break;
                }
            }
        }
    }
    Some(name)
}
fn skills_at(
    scan: &mut Scan,
    root: &Path,
    key: &str,
    cache: &BTreeMap<String, (String, String)>,
    home: &Path,
) -> BTreeSet<String> {
    let folders = safe::children(root);
    let mut names = BTreeSet::new();
    let mut count = 0;
    if let Some(folders) = &folders {
        for folder in folders {
            if folder.join("SKILL.md").is_file() {
                count += 1;
                if let Some(name) = skill(scan, &folder.join("SKILL.md"), cache, home) {
                    names.insert(name);
                }
            }
        }
    }
    scan.service.stat(key, folders.map(|_| count));
    names
}
fn chain(cwd: &Path) -> Vec<PathBuf> {
    let mut out: Vec<_> = cwd.ancestors().map(Path::to_owned).collect();
    out.reverse();
    out
}
fn references(scan: &mut Scan, idx: usize, text: &str, root: &Path) {
    let mut hits = vec![];
    let (_, body) = frontmatter::split(text);
    let body_start = text.len() - body.len();
    for prefix in ["references/", "scripts/", "skills/"] {
        for (start, _) in body.match_indices(prefix) {
            let tail = &body[start..];
            let end = tail
                .find(|c: char| !c.is_ascii_alphanumeric() && !"_-./".contains(c))
                .unwrap_or(tail.len());
            let name = tail[..end].trim_end_matches('.');
            if name.len() > prefix.len() {
                hits.push((body_start + start, name.to_owned()));
            }
        }
    }
    hits.sort_by_key(|(start, _)| *start);
    let mut seen = BTreeSet::new();
    let mut previous_end = 0;
    for (pos, name) in hits {
        if pos < previous_end {
            continue;
        }
        previous_end = pos + name.len();
        if !seen.insert(name.clone()) {
            continue;
        }
        let target = root.join(&name);
        if safe::private(&target) || safe::private(&safe::canonical(&target)) {
            continue;
        }
        scan.links.push(Link {
            id: format!("ref:{}:{}", scan.items[idx].id, name),
            from: scan.items[idx].id.clone(),
            to: name,
            source_service: scan.service.id.clone(),
            target_service: scan.service.id.clone(),
            relation: "references".into(),
            evidence: "declaration".into(),
            line: Some(text[..pos].bytes().filter(|b| *b == b'\n').count() as u64 + 1),
            target_path: Some(target.to_string_lossy().into()),
            exists: Some(target.is_file()),
        });
    }
}
fn finish_context(service: &mut Service, include_startup: bool) {
    let mut parts = vec![
        service.context.instructions,
        service.context.memory,
        service.context.listing,
    ];
    if include_startup {
        parts.push(service.context.startup);
    }
    service.context.known_total = parts.iter().flatten().sum();
    service.context.total = parts
        .iter()
        .all(Option::is_some)
        .then_some(service.context.known_total);
}
