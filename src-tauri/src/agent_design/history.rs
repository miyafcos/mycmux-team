//! Metadata-only refresh snapshots. Git is deliberately absent from this path.
#[path = "history_git.rs"]
mod git;
#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

use super::{model::*, safe};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SNAPSHOT_LIMIT: usize = 60;
const TOTAL_LIMIT: u64 = 20 * 1024 * 1024;
static HISTORY_LOCK: Mutex<()> = Mutex::new(());
static PENDING: Mutex<BTreeMap<String, (usize, bool)>> = Mutex::new(BTreeMap::new());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotItem {
    pub id: String,
    pub service: String,
    pub layer: u8,
    pub display_name: String,
    pub path: String,
    pub kind: String,
    pub bytes: Option<u64>,
    pub modified_at: Option<u64>,
    pub document_hash: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadAmount {
    pub service: String,
    #[serde(default)]
    pub state: String,
    pub context: BTreeMap<String, Option<u64>>,
    pub listing_count: Option<u64>,
    pub listing_chars: Option<u64>,
    pub private_count: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u8,
    pub work_folder_key: String,
    pub captured_at: String,
    pub catalog_generated_at: String,
    pub items: Vec<SnapshotItem>,
    pub services: Vec<ReadAmount>,
    #[serde(default)]
    pub memory_unavailable: Vec<String>,
    #[serde(default)]
    pub memory_inventory: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmountChange {
    pub key: String,
    pub before: Option<u64>,
    pub after: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub item_id: Option<String>,
    pub service: String,
    pub layer: u8,
    pub display_name: String,
    pub path: Option<String>,
    pub kind: String,
    pub badge: String,
    pub source: String,
    pub at: String,
    pub before_bytes: Option<u64>,
    pub after_bytes: Option<u64>,
    pub amount_changes: Vec<AmountChange>,
    pub hash: Option<String>,
    pub subject: Option<String>,
    pub author: Option<String>,
    pub lines_added: Option<u64>,
    pub lines_deleted: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub schema_version: u8,
    pub snapshot_count: usize,
    pub captured_at: Option<String>,
    pub writing: bool,
    pub warnings: Vec<String>,
    pub changes: Vec<Change>,
    pub snapshots: Vec<SnapshotPoint>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPoint {
    pub id: String,
    pub captured_at: String,
    pub catalog_generated_at: String,
    pub item_count: usize,
    pub services: Vec<SnapshotServicePoint>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotServicePoint { pub service: String, pub item_count: usize, pub state: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDiff {
    pub mode: String,
    pub lines: Vec<DiffLine>,
    pub before_bytes: Option<u64>,
    pub after_bytes: Option<u64>,
    pub truncated: bool,
    pub status: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistory {
    pub status: String,
    pub changes: Vec<Change>,
}
fn stable_path(path: &Path) -> String {
    let mut normalized = safe::normalized(path);
    if normalized.as_bytes().get(1) == Some(&b':') || normalized.starts_with("//") {
        normalized = normalized.to_lowercase();
    }
    normalized
}
pub fn folder_key(cwd: &Path) -> String {
    format!("{:x}", Sha256::digest(stable_path(cwd).as_bytes()))
}
fn directory(home: &Path) -> PathBuf {
    super::state_dir(home).join("history")
}
fn hex(value: &str, lengths: &[usize]) -> bool {
    lengths.contains(&value.len()) && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn snapshot_name(path: &Path) -> bool {
    let name = safe::basename(path);
    let Some((date, rest)) = name.split_once('-') else { return false; };
    let Some(id) = rest.strip_suffix(".json") else { return false; };
    date.len() == 26 && date.as_bytes().get(8) == Some(&b'T')
        && date.as_bytes().get(15) == Some(&b'.') && date.as_bytes().get(25) == Some(&b'Z')
        && date.bytes().enumerate().all(|(i,b)| [8,15,25].contains(&i) || b.is_ascii_digit())
        && uuid::Uuid::parse_str(id).is_ok()
}
fn no_links(path: &Path) -> Result<(), String> {
    for p in path.ancestors() {
        if let Ok(m) = fs::symlink_metadata(p) {
            if m.file_type().is_symlink() {
                return Err("historyDenied".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return Err("historyDenied".into());
                }
            }
        }
    }
    Ok(())
}
pub fn capture(catalog: &Catalog) -> Snapshot {
    let home = Path::new(&catalog.home);
    let cwd = Path::new(&catalog.cwd);
    let mut items:Vec<_> = catalog.items.iter().filter_map(|item| {
        let path = item.path.as_deref()?;
        // Aggregates point at directories/settings too; they are not files.
        if item.status != "present" || ["runtime", "plugins", "mcp", "hooks", "privateCount"].contains(&item.kind.as_str())
            || safe::private(Path::new(path)) || safe::private(&safe::canonical(Path::new(path))) {
            return None;
        }
        let document_hash = if item.layer != 4 && item.document_allowed && super::authorized(home, cwd, item) {
            catalog.documents.get(&item.id).and_then(|v| v["body"].as_str())
                .map(|body| format!("{:x}", Sha256::digest(body.as_bytes())))
        } else { None };
        Some(SnapshotItem { id: item.id.clone(), service: item.service.clone(), layer: item.layer,
            display_name: item.display_name.clone(), path: path.into(), kind: item.kind.clone(),
            bytes: item.size.bytes, modified_at: item.modified_at, document_hash })
    }).collect();
    let mut known:BTreeSet<_>=items.iter().map(|i|safe::normalized(Path::new(&i.path))).collect();
    let mut memory_unavailable=vec![];
    let mut memory_inventory=vec![];
    // Stage A exposes memory bodies only as counts. Add their filesystem metadata
    // in this background writer, never opening a body or a conversation record.
    for service in catalog.services.iter().filter(|s|s.state=="present" && ["claude","codex"].contains(&s.id.as_str())) {
        let root=Path::new(&service.root);
        // A portable Windows catalog replay on Mac has no local source directory.
        if !root.is_absolute() { continue; }
        let directories=if service.id=="claude" {
            safe::children(&root.join("projects")).map(|paths|paths.into_iter().map(|p|p.join("memory")).filter(|p|p.is_dir()).collect::<Vec<_>>())
        } else { Some(vec![root.join("memories")]) };
        let Some(directories)=directories else { memory_unavailable.push(service.id.clone()); continue; };
        let mut unavailable=false;
        for dir in directories {
            if no_links(&dir).is_err() { unavailable=true; continue; }
            let Some(files)=safe::files(&dir,None) else { unavailable=true; continue; };
            for path in files {
                if safe::private(&path) || safe::private(&safe::canonical(&path)) || !known.insert(safe::normalized(&path)) { continue; }
                let Ok(metadata)=fs::metadata(&path) else { unavailable=true; continue; };
                let path=path.to_string_lossy().into_owned();
                items.push(SnapshotItem { id:format!("{}:memoryFile:{path}",service.id),service:service.id.clone(),layer:4,
                    display_name:safe::basename(Path::new(&path)),path,kind:"memoryFile".into(),bytes:Some(metadata.len()),
                    modified_at:metadata.modified().ok().and_then(|m|m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_millis() as u64),document_hash:None });
            }
        }
        if unavailable { memory_unavailable.push(service.id.clone()); } else { memory_inventory.push(service.id.clone()); }
    }
    let services = catalog.services.iter().map(|s| ReadAmount {
        service: s.id.clone(), state: s.state.clone(), context: BTreeMap::from([
            ("instructions".into(), s.context.instructions), ("memory".into(), s.context.memory),
            ("listing".into(), s.context.listing), ("startup".into(), s.context.startup),
            ("product".into(), s.context.product), ("total".into(), s.context.total),
            ("knownTotal".into(), Some(s.context.known_total)),
        ]), listing_count: s.session.listing.count, listing_chars: s.session.listing.chars,
        private_count: s.stats.get("privateFiles").or_else(|| s.stats.get("tokensFiles")).copied().flatten(),
    }).collect();
    Snapshot { schema_version: 1, work_folder_key: folder_key(cwd),
        captured_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        catalog_generated_at: catalog.generated_at.clone(), items, services, memory_unavailable, memory_inventory }
}
fn files(root: &Path) -> Result<Vec<(PathBuf, u64)>, String> {
    no_links(root)?;
    if !root.exists() { return Ok(vec![]); }
    let mut out = vec![];
    for dir in fs::read_dir(root).map_err(|_| "historyUnavailable")? {
        let dir = dir.map_err(|_| "historyUnavailable")?.path();
        if !hex(&safe::basename(&dir), &[64]) { continue; }
        no_links(&dir)?;
        if !dir.is_dir() { continue; }
        for file in fs::read_dir(&dir).map_err(|_| "historyUnavailable")? {
            let file = file.map_err(|_| "historyUnavailable")?.path();
            no_links(&file)?;
            if snapshot_name(&file) && file.is_file() {
                let size = fs::metadata(&file).map_err(|_| "historyUnavailable")?.len();
                out.push((file, size));
            }
        }
    }
    out.sort_by(|a,b| safe::basename(&a.0).cmp(&safe::basename(&b.0)).then(a.0.cmp(&b.0)));
    Ok(out)
}
fn prune(root: &Path, folder: &Path) -> Result<(), String> {
    let mut all = files(root)?;
    let own: Vec<_> = all.iter().filter(|(p,_)| p.parent() == Some(folder)).map(|(p,_)| p.clone()).collect();
    for p in own.iter().take(own.len().saturating_sub(SNAPSHOT_LIMIT)) {
        fs::remove_file(p).map_err(|_| "historyPruneFailed")?;
        all.retain(|(path,_)| path != p);
    }
    let mut total: u64 = all.iter().map(|(_,size)| size).sum();
    for (p,size) in all {
        if total <= TOTAL_LIMIT { break; }
        fs::remove_file(p).map_err(|_| "historyPruneFailed")?;
        total = total.saturating_sub(size);
    }
    Ok(())
}
fn write(root: &Path, snapshot: &Snapshot) -> Result<PathBuf, String> {
    if !hex(&snapshot.work_folder_key, &[64]) { return Err("historyDenied".into()); }
    let _guard = HISTORY_LOCK.lock().map_err(|_| "historyUnavailable")?;
    let folder = root.join(&snapshot.work_folder_key);
    no_links(&folder)?;
    fs::create_dir_all(&folder).map_err(|_| "historyUnavailable")?;
    let bytes = serde_json::to_vec(snapshot).map_err(|_| "serializationFailed")?;
    if bytes.len() as u64 > TOTAL_LIMIT { return Err("historyTooLarge".into()); }
    let name = format!("{}-{}.json", chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ"), uuid::Uuid::new_v4());
    let target = folder.join(name);
    let mut file = tempfile::NamedTempFile::new_in(&folder).map_err(|_| "historyUnavailable")?;
    file.write_all(&bytes).map_err(|_| "historyUnavailable")?;
    file.as_file().sync_all().map_err(|_| "historyUnavailable")?;
    file.persist(&target).map_err(|_| "historyWriteFailed")?;
    prune(root, &folder)?;
    Ok(target)
}
pub fn enqueue(home: PathBuf, catalog: Catalog) {
    let key = folder_key(Path::new(&catalog.cwd));
    if let Ok(mut pending) = PENDING.lock() { pending.entry(key.clone()).or_default().0 += 1; }
    std::thread::spawn(move || {
        let result = write(&directory(&home), &capture(&catalog));
        if let Ok(mut pending) = PENDING.lock() {
            let status = pending.entry(key).or_default();
            status.0 = status.0.saturating_sub(1); status.1 = result.is_err();
        }
    });
}
fn snapshots(root: &Path, cwd: &Path) -> Result<(Vec<Snapshot>, bool), String> {
    let _guard = HISTORY_LOCK.lock().map_err(|_| "historyUnavailable")?;
    let key = folder_key(cwd);
    let folder = root.join(&key);
    no_links(&folder)?;
    if !folder.exists() { return Ok((vec![], false)); }
    let mut paths = fs::read_dir(&folder).map_err(|_| "historyUnavailable")?
        .filter_map(Result::ok).map(|e| e.path()).filter(|p| snapshot_name(p)).collect::<Vec<_>>();
    paths.sort();
    let mut out = vec![]; let mut invalid = false; let mut consumed = 0u64;
    for path in paths.into_iter().rev().take(SNAPSHOT_LIMIT) {
        no_links(&path)?;
        let size = fs::metadata(&path).map_err(|_| "historyUnavailable")?.len();
        consumed += size;
        if consumed > TOTAL_LIMIT { invalid = true; break; }
        let snapshot = safe::text(&path, TOTAL_LIMIT).and_then(|s| serde_json::from_str::<Snapshot>(&s).ok());
        match snapshot {
            Some(s) if s.schema_version == 1 && s.work_folder_key == key && s.items.iter().all(|i| {
                (1..=7).contains(&i.layer) && !safe::private(Path::new(&i.path))
                    && i.document_hash.as_ref().is_none_or(|h| hex(h, &[64]) && i.layer != 4)
            }) => out.push(s),
            _ => invalid = true,
        }
    }
    out.sort_by(|a,b| a.captured_at.cmp(&b.captured_at));
    Ok((out, invalid))
}
pub fn compare(before: &Snapshot, after: &Snapshot) -> Vec<Change> {
    let old: BTreeMap<_,_> = before.items.iter().map(|i| (&i.id,i)).collect();
    let new: BTreeMap<_,_> = after.items.iter().map(|i| (&i.id,i)).collect();
    let keys: BTreeSet<_> = old.keys().chain(new.keys()).copied().collect();
    let mut changes = vec![];
    for id in keys {
        let a = old.get(id).copied(); let b = new.get(id).copied();
        if a == b || a.zip(b).is_some_and(|(a,b)| a.bytes==b.bytes && a.modified_at==b.modified_at
            && a.document_hash==b.document_hash && stable_path(Path::new(&a.path))==stable_path(Path::new(&b.path))) { continue; }
        let item = b.or(a).unwrap();
        if item.kind=="memoryFile" && (!before.memory_inventory.contains(&item.service) || !after.memory_inventory.contains(&item.service)
            || before.memory_unavailable.contains(&item.service) || after.memory_unavailable.contains(&item.service)) { continue; }
        changes.push(Change { id: format!("snapshot:{}:{id}", after.captured_at), item_id: Some(id.clone()),
            service: item.service.clone(), layer: item.layer, display_name: item.display_name.clone(), path: Some(item.path.clone()),
            kind: if a.is_none() { "added" } else if b.is_none() { "deleted" } else { "changed" }.into(),
            badge: "fileChanged".into(), source: "snapshot".into(), at: after.captured_at.clone(),
            before_bytes: a.and_then(|i| i.bytes), after_bytes: b.and_then(|i| i.bytes), amount_changes: vec![],
            hash: None, subject: None, author: None, lines_added: None, lines_deleted: None });
    }
    for b in &after.services {
        let Some(a) = before.services.iter().find(|s| s.service == b.service) else { continue; };
        let mut metrics_a = a.context.clone(); let mut metrics_b = b.context.clone();
        metrics_a.insert("listingCount".into(), a.listing_count); metrics_b.insert("listingCount".into(), b.listing_count);
        metrics_a.insert("listingChars".into(), a.listing_chars); metrics_b.insert("listingChars".into(), b.listing_chars);
        let amounts: Vec<_> = metrics_b.iter().filter(|(k,v)| metrics_a.get(*k) != Some(*v)).map(|(key,v)| AmountChange {
            key: key.clone(), before: metrics_a.get(key).copied().flatten(), after: *v,
        }).collect();
        if amounts.is_empty() { continue; }
        changes.push(Change { id: format!("amount:{}:{}", after.captured_at,b.service), item_id: None,
            service: b.service.clone(), layer: 0, display_name: "readAmount".into(), path: None, kind: "changed".into(),
            badge: "readAmountChanged".into(), source: "snapshot".into(), at: after.captured_at.clone(),
            before_bytes: None, after_bytes: None, amount_changes: amounts, hash: None, subject: None, author: None,
            lines_added: None, lines_deleted: None });
    }
    changes
}
pub fn timeline(home: &Path, cwd: &Path) -> Result<History, String> {
    let (snapshots, invalid) = snapshots(&directory(home), cwd)?;
    let pending = PENDING.lock().ok().and_then(|p| p.get(&folder_key(cwd)).copied()).unwrap_or_default();
    let mut changes: Vec<_> = snapshots.windows(2).flat_map(|pair| compare(&pair[0], &pair[1])).collect();
    changes.sort_by(|a,b| b.at.cmp(&a.at).then(a.id.cmp(&b.id)));
    let mut warnings = vec![];
    if invalid { warnings.push("historyUnsupported".into()); }
    if pending.1 { warnings.push("historyWriteFailed".into()); }
    if snapshots.last().is_some_and(|s|!s.memory_unavailable.is_empty()) { warnings.push("memoryMetadataUnavailable".into()); }
    Ok(History { schema_version: 1, snapshot_count: snapshots.len(), captured_at: snapshots.last().map(|s| s.captured_at.clone()),
        writing: pending.0 > 0, warnings, changes, snapshots: snapshots.iter().map(|s| SnapshotPoint {
            id: s.captured_at.clone(), captured_at: s.captured_at.clone(),
            catalog_generated_at: s.catalog_generated_at.clone(), item_count: s.items.len(),
            services: s.services.iter().map(|service| SnapshotServicePoint { service: service.service.clone(), state: service.state.clone(), item_count: s.items.iter().filter(|i| i.service == service.service).count() }).collect(),
        }).collect() })
}
pub fn pair(home: &Path, cwd: &Path, before: &str, after: &str) -> Result<Vec<Change>, String> {
    let (points, _) = snapshots(&directory(home), cwd)?;
    let a = points.iter().position(|s| s.captured_at == before).ok_or("snapshotUnavailable")?;
    let b = points.iter().position(|s| s.captured_at == after).ok_or("snapshotUnavailable")?;
    if a >= b { return Err("snapshotOrderDenied".into()); }
    Ok(compare(&points[a], &points[b]))
}
fn target(home: &Path, cwd: &Path, catalog: &Catalog, id: &str) -> Result<Item, String> {
    if let Some(item) = catalog.items.iter().find(|i| i.id == id) { return Ok(item.clone()); }
    let (old,_) = snapshots(&directory(home), cwd)?;
    let item = old.iter().rev().flat_map(|s| &s.items).find(|i| i.id == id).ok_or("itemUnavailable")?;
    Ok(Item { id: item.id.clone(), service: item.service.clone(), layer: item.layer,
        display_name: item.display_name.clone(), path: Some(item.path.clone()), kind: item.kind.clone(),
        status: "absent".into(), size: Size { bytes: item.bytes, ..Default::default() }, read_timing: "outside".into(),
        evidence: "unknown".into(), modified_at: item.modified_at, fields: vec![], conditions: vec![],
        document_allowed: ["instruction","override","shadowedInstruction","rule","reference","agent","command"].contains(&item.kind.as_str()), active: false })
}
pub fn git_history(home: &Path, cwd: &Path, catalog: &Catalog, id: &str) -> Result<GitHistory, String> {
    git::list(home, cwd, &target(home,cwd,catalog,id)?, &git::Runner::default())
}
pub fn git_diff(home: &Path, cwd: &Path, catalog: &Catalog, id: &str, hash: &str) -> Result<HistoryDiff, String> {
    git::diff(home, cwd, &target(home,cwd,catalog,id)?, hash, &git::Runner::default())
}
