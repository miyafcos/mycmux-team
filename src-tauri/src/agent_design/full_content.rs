//! Desktop-only full content. Portable still calls the original document() contract.
use super::{model::*, redaction, safe, Catalog};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

struct Content {
    item: Item,
    roots: Vec<PathBuf>,
    default: Option<PathBuf>,
    generated: Option<String>,
    exact: std::collections::BTreeMap<usize, PathBuf>,
}
fn root_for(home: &Path, catalog: &Catalog, service: &str) -> Result<PathBuf, String> {
    let root = catalog
        .services
        .iter()
        .find(|s| s.id == service)
        .map(|s| PathBuf::from(&s.root))
        .ok_or("itemUnavailable")?;
    let expected = match service {
        "claude" => home.join(".claude"),
        "codex" => super::codex_root(home),
        "hermes" => super::hermes_root(home),
        _ => return Err("itemUnavailable".into()),
    };
    if safe::canonical(&root) != safe::canonical(&expected) {
        return Err("documentDenied".into());
    }
    Ok(root)
}
fn within(path: &Path, base: &Path) -> bool {
    path.starts_with(base) && safe::canonical(path).starts_with(safe::canonical(base))
}
fn registered(home: &Path, cwd: &Path, item: &Item, root: &Path) -> bool {
    let Some(path) = item.path.as_deref().map(Path::new) else {
        return true;
    };
    let name = safe::basename(path);
    match item.kind.as_str() {
        "instruction" | "override" | "shadowedInstruction" => {
            super::authorized(home, cwd, item)
                || (item.service == "hermes" && path == root.join("SOUL.md"))
        }
        "settings" | "settingsLocal" | "mcp" | "plugins" => [
            "settings.json",
            "settings.local.json",
            "config.toml",
            "config.yaml",
            "hooks.json",
        ]
        .iter()
        .any(|n| path == root.join(n)),
        "hooks" => {
            path == root.join(if item.service == "codex" {
                "hooks.json"
            } else {
                "settings.json"
            }) || path == root.join("settings.local.json")
        }
        "rule" => within(path, &root.join("rules")),
        "permissionRules" => path == root.join("rules/default.rules"),
        "agent" => within(path, &root.join("agents")),
        "command" => within(path, &root.join("commands")),
        "skill" => {
            name == "SKILL.md"
                && [
                    root.join("skills"),
                    root.join("plugins"),
                    home.join(".agents/skills"),
                    cwd.join(".claude/skills"),
                ]
                .iter()
                .any(|r| within(path, r))
        }
        "reference" => within(path, &root.join("references")),
        "script" => within(path, &root.join("scripts")) || within(path, &root.join("hooks")),
        "memoryIndex" | "memoryDirectory" => {
            within(path, &root.join("memories"))
                || (within(path, &root.join("projects"))
                    && path.components().any(|c| c.as_os_str() == "memory"))
        }
        "cron" => within(path, &root.join("cron")),
        "runtime" => path == root,
        _ => within(path, root),
    }
}

fn add_exact(
    roots: &mut Vec<PathBuf>,
    exact: &mut std::collections::BTreeMap<usize, PathBuf>,
    path: PathBuf,
) {
    if !path.is_file()
        || exact
            .values()
            .any(|p| safe::canonical(p) == safe::canonical(&path))
    {
        return;
    }
    if roots
        .iter()
        .enumerate()
        .any(|(n, r)| !exact.contains_key(&n) && within(&path, r))
    {
        return;
    }
    if let Some(parent) = path.parent() {
        let index = roots.len();
        roots.push(parent.to_owned());
        exact.insert(index, path);
    }
}
fn command_files(value: &Value, home: &Path, root: &Path, out: &mut Vec<PathBuf>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "command" {
                    if let Some(command) = value.as_str() {
                        let mut words = Vec::new();
                        let mut word = String::new();
                        let mut quote = None;
                        for ch in command.chars() {
                            if matches!(ch, '\x22' | '\x27') {
                                if quote == Some(ch) {
                                    quote = None;
                                } else if quote.is_none() {
                                    quote = Some(ch);
                                } else {
                                    word.push(ch);
                                }
                            } else if ch.is_whitespace() && quote.is_none() {
                                if !word.is_empty() {
                                    words.push(std::mem::take(&mut word));
                                }
                            } else {
                                word.push(ch);
                            }
                        }
                        if !word.is_empty() {
                            words.push(word);
                        }
                        for word in words {
                            let word = word
                                .replace(concat!("$", "{HOME}"), &home.to_string_lossy())
                                .replace("$HOME", &home.to_string_lossy())
                                .replace("%USERPROFILE%", &home.to_string_lossy())
                                .replace(
                                    concat!("$", "{CLAUDE_CONFIG_DIR}"),
                                    &root.to_string_lossy(),
                                )
                                .replace("$CLAUDE_CONFIG_DIR", &root.to_string_lossy());
                            let word = word
                                .strip_prefix("~/")
                                .map(|p| home.join(p))
                                .unwrap_or_else(|| PathBuf::from(&word));
                            if !word.extension().is_some_and(|e| {
                                ["py", "sh", "ps1", "js", "cjs", "mjs", "ts", "bat", "cmd"]
                                    .iter()
                                    .any(|v| e.to_string_lossy().eq_ignore_ascii_case(v))
                            }) {
                                continue;
                            }
                            let path = if word.is_absolute() {
                                word
                            } else {
                                root.join(&word)
                            };
                            if path.is_file() {
                                out.push(path);
                            }
                        }
                    }
                } else {
                    command_files(value, home, root, out);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                command_files(value, home, root, out);
            }
        }
        _ => {}
    }
}

fn scheduled_content(home: &Path, root: &Path) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("schtasks")
            .args(["/query", "/fo", "csv", "/v"])
            .creation_flags(0x08000000)
            .output()
            .map_err(|_| "scheduledUnavailable")?;
        if !output.status.success() {
            return Err("scheduledUnavailable".into());
        }
        let text = String::from_utf8(output.stdout.clone())
            .unwrap_or_else(|_| encoding_rs::SHIFT_JIS.decode(&output.stdout).0.into_owned());
        let root = root.to_string_lossy().replace('\\', "/").to_lowercase() + "/";
        let records = super::scheduled::csv(&text);
        let header = records.first().cloned().unwrap_or_default();
        let rows: Vec<_> = records
            .into_iter()
            .skip(1)
            .filter(|r| {
                r.iter()
                    .any(|v| v.replace('\\', "/").to_lowercase().contains(&root))
            })
            .map(|row| {
                header
                    .iter()
                    .cloned()
                    .zip(row.into_iter().map(Value::String))
                    .collect::<serde_json::Map<String, Value>>()
            })
            .collect();
        return serde_json::to_string_pretty(&json!({"columns":header,"registrations":rows}))
            .map_err(|_| "serializationFailed".into());
    }
    #[cfg(target_os = "macos")]
    {
        let mut definitions = Vec::new();
        let root = root.to_string_lossy().replace('\\', "/") + "/";
        let paths =
            fs::read_dir(home.join("Library/LaunchAgents")).map_err(|_| "scheduledUnavailable")?;
        for entry in paths.filter_map(Result::ok) {
            let path = entry.path();
            if !path.extension().is_some_and(|e| e == "plist") {
                continue;
            }
            let read = read_text(&path)?;
            if super::scheduled::parse_plist(&read.text)
                .is_some_and(|(args, _)| args.iter().any(|v| v.replace('\\', "/").contains(&root)))
            {
                definitions.push(json!({"file":entry.file_name().to_string_lossy(),"definition":read.text,"bytes":read.bytes,"truncated":read.truncated}));
            }
        }
        return serde_json::to_string_pretty(&definitions)
            .map_err(|_| "serializationFailed".into());
    }
    #[allow(unreachable_code)]
    {
        let _ = (home, root);
        Err("scheduledUnavailable".into())
    }
}
fn content(home: &Path, cwd: &Path, catalog: &Catalog, id: &str) -> Result<Content, String> {
    let item = catalog
        .items
        .iter()
        .find(|i| i.id == id)
        .cloned()
        .or_else(|| super::skill_read::content_item(home, catalog, id))
        .ok_or("itemUnavailable")?;
    let root = root_for(home, catalog, &item.service)?;
    let listed_skill=item.kind=="skill" && item.path.as_deref().is_some_and(|p|super::skill_read::listed_source(home,catalog,Path::new(p)).is_some_and(|service|service==item.service));
    if !registered(home, cwd, &item, &root) && !listed_skill {
        return Err("documentDenied".into());
    }
    let path = item.path.as_deref().map(PathBuf::from);
    let mut roots = Vec::new();
    let mut default = None;
    let mut generated = None;
    if let Some(path) = path {
        if path.is_dir() || matches!(item.kind.as_str(), "memoryDirectory" | "cron" | "runtime") {
            roots.push(path);
        } else {
            roots.push(path.parent().ok_or("documentDenied")?.to_owned());
            default = Some(path);
        }
    } else {
        roots.push(root.clone());
        let service = catalog
            .services
            .iter()
            .find(|s| s.id == item.service)
            .ok_or("itemUnavailable")?;
        generated=Some(serde_json::to_string_pretty(&match item.kind.as_str() {
            "skillListing"=>serde_json::to_value(&service.session.listing).map_err(|_|"serializationFailed")?,
            "scheduled"=>json!({"registration":scheduled_content(home,&root).unwrap_or_else(|reason|reason)}),
            "privateCount"=>json!({"files":item.fields}),
            _=>serde_json::to_value(&item).map_err(|_|"serializationFailed")?,
        }).map_err(|_|"serializationFailed")?);
    }
    if matches!(item.kind.as_str(), "hooks" | "plugins" | "scheduled") {
        for name in match item.kind.as_str() {
            "hooks" => vec!["hooks", "scripts"],
            "plugins" => vec!["plugins"],
            _ => vec!["cron", "jobs"],
        } {
            let extra = root.join(name);
            if extra.is_dir()
                && !roots
                    .iter()
                    .any(|r| safe::canonical(r) == safe::canonical(&extra))
            {
                roots.push(extra);
            }
        }
    }
    let mut exact = std::collections::BTreeMap::new();
    if item.kind == "mcp" && item.service == "claude" {
        add_exact(&mut roots, &mut exact, home.join(".claude.json"));
    }
    if item.kind == "hooks" {
        if let Some(path) = default.as_ref() {
            if let Ok(read) = read_text(path) {
                if let Ok(value) = serde_json::from_str::<Value>(&read.text) {
                    let mut declared = Vec::new();
                    command_files(&value, home, &root, &mut declared);
                    for path in declared {
                        add_exact(&mut roots, &mut exact, path);
                    }
                }
            }
        }
    }
    Ok(Content {
        item,
        roots,
        default,
        generated,
        exact,
    })
}
fn selected(
    c: &Content,
    relative: Option<&str>,
) -> Result<(Option<PathBuf>, usize, String), String> {
    let Some(relative) = relative else {
        let name = c
            .default
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if c.default
            .as_ref()
            .is_some_and(|p| !safe::canonical(p).starts_with(safe::canonical(&c.roots[0])))
        {
            return Err("documentDenied".into());
        }
        return Ok((c.default.clone(), 0, format!("0/{name}")));
    };
    let (index, path) = relative.split_once('/').ok_or("documentDenied")?;
    let index = index.parse::<usize>().map_err(|_| "documentDenied")?;
    let base = c.roots.get(index).ok_or("documentDenied")?;
    if path.contains('\\')
        || path.contains(':')
        || Path::new(path)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("documentDenied".into());
    }
    let target = base.join(path);
    if c.exact
        .get(&index)
        .is_some_and(|file| !path.is_empty() && safe::canonical(&target) != safe::canonical(file))
    {
        return Err("documentDenied".into());
    }
    if !safe::canonical(&target).starts_with(safe::canonical(base)) {
        return Err("documentDenied".into());
    }
    Ok((Some(target), index, relative.into()))
}
fn listing(
    c: &Content,
    index: usize,
    path: &Path,
    offset: usize,
) -> Result<(Vec<Value>, usize), String> {
    let root = &c.roots[index];
    if !safe::canonical(path).starts_with(safe::canonical(root)) {
        return Err("documentDenied".into());
    }
    let mut entries = fs::read_dir(path)
        .map_err(|_| "fileUnreadable")?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    if let Some(file) = c.exact.get(&index) {
        entries.retain(|e| e.path() == *file);
    }
    entries.sort_by_key(|e| e.file_name());
    if c.item.kind == "privateCount" && path == root {
        entries.retain(|e| safe::private(&e.path()));
    }
    let total = entries.len();
    let mut out = Vec::new();
    for e in entries.into_iter().skip(offset).take(500) {
        let p = e.path();
        let meta = fs::metadata(&p).ok();
        let relative = p
            .strip_prefix(root)
            .map_err(|_| "documentDenied")?
            .to_string_lossy()
            .replace('\\', "/");
        let redirected = !safe::canonical(&p).starts_with(safe::canonical(root));
        out.push(json!({"id":format!("{index}/{relative}"),"name":e.file_name().to_string_lossy(),"directory":meta.as_ref().is_some_and(|m|m.is_dir()),
            "bytes":meta.as_ref().map(|m|m.len()),"private":safe::private(&p)||safe::private(&safe::canonical(&p)),
            "reason":if redirected{Some("outsideFolder")}else{None::<&str>}}));
    }
    Ok((out, total))
}
pub struct ReadText {
    pub text: String,
    pub bytes: u64,
    pub truncated: bool,
    pub revision: String,
}
pub fn read_text(path: &Path) -> Result<ReadText, String> {
    // File::open does not write, lock or change the source's modification time.
    let file = File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "fileMissing"
        } else {
            "fileUnreadable"
        }
    })?;
    let meta = file.metadata().map_err(|_| "fileUnreadable")?;
    if !meta.is_file() {
        return Err("notAFile".into());
    }
    let mut bytes = Vec::new();
    file.take(safe::DOCUMENT_LIMIT + 4)
        .read_to_end(&mut bytes)
        .map_err(|_| "fileUnreadable")?;
    let truncated = meta.len() > safe::DOCUMENT_LIMIT;
    if bytes.len() > safe::DOCUMENT_LIMIT as usize {
        bytes.truncate(safe::DOCUMENT_LIMIT as usize);
    }
    let mut digest = Sha256::new();
    digest.update(&bytes);
    digest.update(meta.len().to_le_bytes());
    let revision = format!("{:x}", digest.finalize());
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        if !truncated && bytes.len() % 2 != 0 {
            return Err("unsupportedEncoding".into());
        }
        let mut units = bytes[2..]
            .chunks_exact(2)
            .map(|p| {
                if little {
                    u16::from_le_bytes([p[0], p[1]])
                } else {
                    u16::from_be_bytes([p[0], p[1]])
                }
            })
            .collect::<Vec<_>>();
        if truncated && units.last().is_some_and(|u| (0xd800..=0xdbff).contains(u)) {
            units.pop();
        }
        char::decode_utf16(units)
            .collect::<Result<String, _>>()
            .map_err(|_| "unsupportedEncoding")?
    } else {
        loop {
            match String::from_utf8(bytes.clone()) {
                Ok(text) => break text,
                Err(e) if truncated && e.utf8_error().error_len().is_none() => {
                    bytes.truncate(e.utf8_error().valid_up_to());
                }
                Err(_) => return Err("unsupportedEncoding".into()),
            }
        }
    };
    if text.contains('\0') {
        return Err("binaryFile".into());
    }
    Ok(ReadText {
        text,
        bytes: meta.len(),
        truncated,
        revision,
    })
}
pub fn markdown(response: &mut Value, body: &str) {
    use kuchikiki::traits::TendrilSink;
    let (frontmatter, text) = super::frontmatter::split(body);
    let html = super::stage1_bridge::detail::markdown(text);
    let tree = kuchikiki::parse_html().one(html.clone()).document_node;
    let toc:Vec<_>=tree.select("h1,h2,h3,h4,h5,h6").into_iter().flatten().map(|h|
        json!({"level":h.name.local.to_string()[1..].parse::<usize>().unwrap_or(1),"text":h.text_contents()})).collect();
    response["frontmatter"] = frontmatter;
    response["html"] = json!(html);
    response["toc"] = json!(toc);
}
pub fn opened(
    home: &Path,
    cwd: &Path,
    catalog: &Catalog,
    id: &str,
    relative: Option<&str>,
    offset: usize,
) -> Result<Value, String> {
    let c = content(home, cwd, catalog, id)?;
    let (selected, index, relative) = selected(&c, relative)?;
    let path = selected.as_ref().unwrap_or(&c.roots[index]);
    let folder = if path.is_dir() || selected.is_none() {
        path.as_path()
    } else {
        path.parent().ok_or("documentDenied")?
    };
    let listed = listing(&c, index, folder, offset);
    let list_reason = listed.as_ref().err().cloned();
    let (mut files, total) = listed.unwrap_or_default();
    let folder_id = format!(
        "{index}/{}",
        folder
            .strip_prefix(&c.roots[index])
            .map_err(|_| "documentDenied")?
            .to_string_lossy()
            .replace('\\', "/")
    );
    if relative.starts_with("0/") && offset == 0 {
        for (n, root) in c.roots.iter().enumerate().skip(1) {
            let exact = c.exact.get(&n);
            let name = exact
                .unwrap_or(root)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy();
            files.insert(0,json!({"id":if exact.is_some(){format!("{n}/{name}")}else{format!("{n}/")},"name":name,"directory":exact.is_none(),"bytes":exact.and_then(|p|fs::metadata(p).ok()).map(|m|m.len()),"private":exact.is_some_and(|p|safe::private(p)||safe::private(&safe::canonical(p))),"reason":null}));
        }
    }
    let parent = folder
        .strip_prefix(&c.roots[index])
        .ok()
        .filter(|p| !p.as_os_str().is_empty())
        .and_then(Path::parent)
        .map(|p| format!("{index}/{}", p.to_string_lossy().replace('\\', "/")));
    let mut fields = serde_json::to_value(&c.item.fields).map_err(|_| "serializationFailed")?;
    redaction::scrub(&mut fields);
    let mut response = json!({"id":id,"body":null,"fields":fields,"size":c.item.size,"status":"present",
        "files":files,"fileCount":total,"fileOffset":offset,"nextOffset":if offset+500<total{Some(offset+500)}else{None},
        "relative":if c.generated.is_some() && selected.is_none(){None::<String>}else{Some(relative)},"parent":parent,"folder":folder_id,"path":selected,"reason":list_reason,"masks":[]});
    let raw = if let Some(path) = selected.as_ref().filter(|p| !p.is_dir()) {
        match read_text(path) {
            Ok(read) => {
                response["revision"] = json!(read.revision);
                response["truncated"] = json!(read.truncated);
                response["size"] = json!({"bytes":read.bytes,"chars":read.text.chars().count(),"lines":read.text.lines().count()});
                Some(read.text)
            }
            Err(reason) => {
                response["reason"] = json!(reason);
                response["status"] = json!("unavailable");
                None
            }
        }
    } else {
        c.generated.clone()
    };
    if let Some(raw) = raw {
        let private = selected
            .as_ref()
            .is_some_and(|p| safe::private(p) || safe::private(&safe::canonical(p)));
        let masked = redaction::mask(&raw, private);
        if response["revision"].is_null() {
            response["revision"] = json!(format!("{:x}", Sha256::digest(raw.as_bytes())));
        }
        response["body"] = json!(masked.body);
        response["masks"] = json!(masked.masks);
        if selected
            .as_ref()
            .and_then(|p| p.extension())
            .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("md"))
        {
            markdown(&mut response, &masked.body);
        }
    } else if c.item.kind == "runtime" {
        response["reason"] = json!("compiledProduct");
    } else if !path.exists() {
        response["reason"] = json!("fileMissing");
        response["status"] = json!("unavailable");
    }
    Ok(response)
}
pub fn reveal(
    home: &Path,
    cwd: &Path,
    catalog: &Catalog,
    id: &str,
    relative: Option<&str>,
    index: usize,
    revision: &str,
) -> Result<String, String> {
    let c = content(home, cwd, catalog, id)?;
    let (path, _, _) = selected(&c, relative)?;
    let generated_private = path.as_ref().is_some_and(|p| safe::private(p) || safe::private(&safe::canonical(p)));
    let (raw, actual, private) = if let Some(path) = path.filter(|p| !p.is_dir()) {
        let read = read_text(&path)?;
        (
            read.text,
            read.revision,
            safe::private(&path) || safe::private(&safe::canonical(&path)),
        )
    } else {
        let raw = c.generated.ok_or("maskUnavailable")?;
        let actual = format!("{:x}", Sha256::digest(raw.as_bytes()));
        (raw, actual, generated_private)
    };
    if actual != revision {
        return Err("documentChanged".into());
    }
    redaction::mask(&raw, private)
        .values
        .get(index)
        .cloned()
        .ok_or_else(|| "maskUnavailable".into())
}
