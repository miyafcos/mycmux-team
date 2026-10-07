//! Local file views and ZIP plans. Private names are rejected before opening.
use super::catalog::{canonical, children, mtime};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path};

pub const LIMIT_BYTES: u64 = 50 * 1024 * 1024;
pub const LIMIT_FILES: usize = 5000;
const PRIVATE: &[&str] = &[
    ".env*",
    "*.env*",
    "*credentials*",
    "*token*",
    "*secret*",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    "id_dsa*",
    "*.pem",
    "*.key",
    "*.ppk",
    "*.p12",
    "*.pfx",
    ".ssh",
    ".gnupg",
    "_state",
    ".git",
    "auth.json",
    "cookies*",
];
const NEVER_DIRS: &[&str] = &[
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "node_modules",
    ".venv",
    "venv",
    ".tox",
    ".idea",
    ".vscode",
];
const NEVER_FILES: &[&str] = &["*.pyc", "*.pyo", ".ds_store", "thumbs.db", "desktop.ini"];
const RULES: &[(&str, &[&str], &[&str])] = &[
    (
        "backup",
        &[
            "_backup*",
            "backup*",
            "_bak*",
            "bak",
            "*_bak",
            "*.bak*",
            "_archive*",
            "archive",
            "*_old",
            "old",
        ],
        &[
            "*.bak", "*.bak-*", "*.bak_*", "*.orig", "*.old", "*~", "*.swp",
        ],
    ),
    (
        "record",
        &[
            "state",
            "states",
            "log",
            "logs",
            "history",
            "runs",
            "cache",
            "caches",
            "tmp",
            "temp",
            "self-improve",
            "store",
            "mirror",
            "mirror_*",
            "*quarantine*",
            "inbox",
            "outbox",
            "trash",
            ".trash",
            "learned",
        ],
        &[
            "*.log",
            "*.err",
            "*.jsonl",
            "*.db",
            "*.sqlite",
            "*.sqlite3",
            "*.lock",
            "state.md",
            "*-log.md",
            "*_log.md",
            "*.pid",
        ],
    ),
    (
        "output",
        &[
            "output",
            "outputs",
            "out",
            "reports",
            "dist",
            "build",
            "exports",
            "export",
            "generated",
            "results",
            "artifacts",
        ],
        &[],
    ),
    (
        "config",
        &[
            "config", "configs", "settings", ".claude", ".codex", ".cursor",
        ],
        &[
            "config.json",
            "*-config.json",
            "*_config.json",
            "settings.json",
            "settings.local.json",
        ],
    ),
    ("data", &["data", "dataset", "datasets", "corpus"], &[]),
];
fn matches(name: &str, patterns: &[&str]) -> bool {
    patterns
        .iter()
        .any(|p| glob::Pattern::new(p).is_ok_and(|p| p.matches(name)))
}
pub fn private_name(name: &str) -> bool {
    matches(&name.to_lowercase(), PRIVATE)
}
pub fn private_path(path: &Path) -> bool {
    path.components()
        .any(|p| matches!(p,Component::Normal(n) if private_name(&n.to_string_lossy())))
}
pub fn reparse(path: &Path) -> bool {
    let Ok(info) = fs::symlink_metadata(path) else {
        return false;
    };
    if info.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
pub fn no_links(path: &Path) -> Result<(), String> {
    if private_path(path) || path.ancestors().any(reparse) {
        return Err("fileDenied".to_owned());
    }
    Ok(())
}
pub fn safe_open(path: &Path) -> Result<File, String> {
    no_links(path)?;
    let expected = canonical(path);
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(|_| "fileNotFound".to_owned())?;
    if !file
        .metadata()
        .map_err(|_| "fileDenied".to_owned())?
        .is_file()
    {
        return Err("fileDenied".to_owned());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFinalPathNameByHandleW(
                handle: *mut std::ffi::c_void,
                path: *mut u16,
                size: u32,
                flags: u32,
            ) -> u32;
        }
        let mut buf = vec![0u16; 32768];
        let count = unsafe {
            GetFinalPathNameByHandleW(file.as_raw_handle(), buf.as_mut_ptr(), buf.len() as u32, 0)
        } as usize;
        if count == 0 || count >= buf.len() {
            return Err("fileDenied".to_owned());
        }
        let opened = String::from_utf16_lossy(&buf[..count]);
        if canonical(Path::new(&opened)) != expected {
            return Err("fileDenied".to_owned());
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        if fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
            .map_err(|_| "fileDenied".to_owned())?
            != expected
        {
            return Err("fileDenied".to_owned());
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let mut buf = [0u8; 1024];
        if unsafe { libc::fcntl(file.as_raw_fd(), 50, buf.as_mut_ptr()) } == -1 {
            return Err("fileDenied".to_owned());
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        if canonical(Path::new(String::from_utf8_lossy(&buf[..end]).as_ref())) != expected {
            return Err("fileDenied".to_owned());
        }
    }
    no_links(path)?;
    Ok(file)
}
pub fn reason(parts: &[String], size: u64) -> Option<String> {
    let names: Vec<_> = parts.iter().map(|s| s.to_lowercase()).collect();
    if names[..names.len().saturating_sub(1)]
        .iter()
        .any(|s| NEVER_DIRS.contains(&s.as_str()))
        || matches(names.last().map(String::as_str).unwrap_or(""), NEVER_FILES)
    {
        return Some("cache".to_owned());
    }
    for (reason, dirs, files) in RULES {
        if names[..names.len().saturating_sub(1)]
            .iter()
            .any(|s| matches(s, dirs))
            || matches(names.last().map(String::as_str).unwrap_or(""), files)
        {
            return Some((*reason).to_owned());
        }
    }
    (size > 5 * 1024 * 1024).then(|| "large".to_owned())
}
pub fn kind(path: &Path) -> &'static str {
    match path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
        .as_str()
    {
        "md" => "md",
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => "image",
        "pdf" => "pdf",
        "rs" | "py" | "js" | "ts" | "tsx" | "sh" | "ps1" | "json" | "yaml" | "yml" | "toml"
        | "txt" | "css" | "html" | "csv" => "text",
        _ => "binary",
    }
}
fn walk(
    root: &Path,
    relative: &Path,
    rows: &mut Vec<Value>,
    blocked: &mut Vec<Value>,
    depth: usize,
) -> Result<(), String> {
    if depth > 40 {
        return Err("folderTooDeep".to_owned());
    }
    for path in children(&root.join(relative)) {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let rel = relative.join(&name);
        let rel_string = rel.to_string_lossy().replace('\\', "/");
        // Do not stat or read a private filename.
        if private_name(&name) {
            blocked.push(json!({"path":rel_string,"name":name,"reason":"private"}));
            continue;
        }
        if reparse(&path) {
            blocked.push(json!({"path":rel_string,"name":name,"reason":"link"}));
            continue;
        }
        let Ok(info) = fs::symlink_metadata(&path) else {
            continue;
        };
        if info.is_dir() {
            walk(root, &rel, rows, blocked, depth + 1)?;
        } else if info.is_file() {
            let parts: Vec<_> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            rows.push(json!({"path":rel_string,"name":name,"depth":parts.len()-1,"dir":false,"size":info.len(),"mtime":mtime(&path),"kind":kind(&path),"reason":reason(&parts,info.len())}));
        }
    }
    Ok(())
}
pub fn plan(document: &Path, id: &str) -> Result<Value, String> {
    no_links(document)?;
    if !document.is_file() {
        return Err("fileNotFound".to_owned());
    }
    let single = !document
        .file_name()
        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("SKILL.md"));
    let root = if single {
        document
    } else {
        document.parent().ok_or("fileNotFound")?
    };
    let mut rows = Vec::new();
    let mut blocked = Vec::new();
    if single {
        let info = fs::metadata(root).map_err(|_| "fileNotFound")?;
        let name = document
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        rows.push(json!({"path":name,"name":name,"depth":0,"dir":false,"size":info.len(),"mtime":mtime(root),"kind":kind(root),"reason":reason(&[name.clone()],info.len())}));
    } else {
        walk(root, Path::new(""), &mut rows, &mut blocked, 0)?;
    }
    rows.sort_by_key(|r| {
        (
            r["path"].as_str().unwrap_or("").to_lowercase(),
            r["path"].as_str().unwrap_or("").to_owned(),
        )
    });
    let mut folders: BTreeMap<String, (usize, u64)> = BTreeMap::new();
    for row in &rows {
        let path = row["path"].as_str().unwrap();
        for (at, _) in path.match_indices('/') {
            let entry = folders.entry(path[..at].to_owned()).or_default();
            entry.0 += 1;
            entry.1 += row["size"].as_u64().unwrap_or(0);
        }
    }
    let mut entries = rows.clone();
    for (path, (count, size)) in folders {
        entries.push(json!({"path":path,"name":path.rsplit('/').next().unwrap(),"depth":path.matches('/').count(),"dir":true,"files":count,"size":size,"kind":"folder"}));
    }
    entries.sort_by_key(|r| r["path"].as_str().unwrap_or("").to_lowercase());
    let selected: Vec<_> = rows
        .iter()
        .filter(|r| r["reason"].is_null())
        .map(|r| r["path"].clone())
        .collect();
    let total: u64 = rows
        .iter()
        .filter(|r| r["reason"].is_null())
        .map(|r| r["size"].as_u64().unwrap_or(0))
        .sum();
    Ok(
        json!({"id":id,"root":canonical(root),"rootName":if single {document.file_stem().unwrap_or_default().to_string_lossy()} else {root.file_name().unwrap_or_default().to_string_lossy()},"single":single,"files":rows,"entries":entries,"blocked":blocked,"selected":selected,"size":total,"limits":{"bytes":LIMIT_BYTES,"files":LIMIT_FILES}}),
    )
}
pub fn selected<'a>(plan: &'a Value, paths: &[String]) -> Result<Vec<&'a Value>, String> {
    let wanted: BTreeSet<_> = paths.iter().collect();
    let all = plan["files"].as_array().ok_or("fileNotFound")?;
    if wanted.len() != paths.len()
        || wanted
            .iter()
            .any(|p| !all.iter().any(|r| r["path"].as_str() == Some(p.as_str())))
    {
        return Err("shareBadRequest".to_owned());
    }
    let mut out = Vec::new();
    let mut size = 0;
    for row in all {
        let path = row["path"].as_str().unwrap_or("");
        if wanted.contains(&path.to_owned()) {
            if row["reason"] == "cache" {
                return Err("fileDenied".to_owned());
            }
            size += row["size"].as_u64().unwrap_or(0);
            out.push(row);
        }
    }
    if all.iter().any(|r| {
        r["path"]
            .as_str()
            .is_some_and(|p| p.eq_ignore_ascii_case("SKILL.md"))
    }) && !paths.iter().any(|p| p.eq_ignore_ascii_case("SKILL.md"))
    {
        return Err("documentRequired".to_owned());
    }
    if out.len() > LIMIT_FILES || size > LIMIT_BYTES {
        return Err("shareTooLarge".to_owned());
    }
    Ok(out)
}
pub fn make_zip(
    document: &Path,
    id: &str,
    paths: &[String],
    destination: &Path,
) -> Result<(), String> {
    let plan = plan(document, id)?;
    let selected = selected(&plan, paths)?;
    if destination.exists() {
        return Err("destinationExists".to_owned());
    }
    // A temporary file in the destination directory permits a no-clobber
    // publish only after every input passed handle and size checks.
    let parent = destination.parent().ok_or("invalidDestination")?;
    if !parent.is_dir() {
        return Err("invalidDestination".to_owned());
    }
    let temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(temporary.as_file());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut bytes = 0u64;
    for row in selected {
        let relative = row["path"].as_str().ok_or("shareBadRequest")?;
        let target = if plan["single"] == true {
            document.to_owned()
        } else {
            document.parent().unwrap().join(relative)
        };
        let file = safe_open(&target)?;
        let mut data = Vec::new();
        file.take(LIMIT_BYTES - bytes + 1)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        bytes += data.len() as u64;
        if bytes > LIMIT_BYTES {
            return Err("shareTooLarge".to_owned());
        }
        let root_name = plan["rootName"].as_str().ok_or("shareBadRequest")?;
        zip.start_file(format!("{root_name}/{relative}"), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    temporary
        .persist_noclobber(destination)
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn preview(document: &Path, id: &str, relative: &str) -> Result<Value, String> {
    let plan = plan(document, id)?;
    let row = plan["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["path"] == relative)
        .ok_or("fileDenied")?;
    if Path::new(relative)
        .components()
        .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("fileDenied".to_owned());
    }
    let path = if plan["single"] == true {
        document.to_owned()
    } else {
        document.parent().unwrap().join(relative)
    };
    let source = safe_open(&path)?;
    if row["kind"] == "pdf"
        || row["kind"] == "binary"
        || row["size"].as_u64().unwrap_or(0) > 5 * 1024 * 1024
    {
        return Ok(json!({"kind":"external","path":canonical(&path),"content":Value::Null}));
    }
    let mut data = Vec::new();
    source
        .take(5 * 1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > 5 * 1024 * 1024 {
        return Err("openExternally".to_owned());
    }
    let content = if row["kind"] == "image" {
        use base64::Engine;
        let mime = match path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "image/png",
        };
        json!(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(data)
        ))
    } else if row["kind"] == "text" || row["kind"] == "md" {
        json!(String::from_utf8(data).map_err(|_| "openExternally")?)
    } else {
        Value::Null
    };
    Ok(json!({"kind":row["kind"],"path":canonical(&path),"content":content}))
}
