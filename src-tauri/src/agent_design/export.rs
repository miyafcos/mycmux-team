use super::{export_book as book, export_privacy as privacy, model::*, safe};
use crate::util::task::run_blocking;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
pub use book::{ExportOptions, ExportPreview, SelectableDocument};

fn list_path(home: &Path) -> PathBuf { super::state_dir(home).join("export-names.txt") }
fn no_links(path: &Path) -> Result<(), String> {
    for parent in path.ancestors() {
        if let Ok(meta) = std::fs::symlink_metadata(parent) {
            if meta.file_type().is_symlink() { return Err("exportPathDenied".into()); }
            #[cfg(windows)] {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 { return Err("exportPathDenied".into()); }
            }
        }
    }
    Ok(())
}
fn names(home: &Path) -> Result<Vec<String>, String> {
    let path = list_path(home);
    no_links(&path)?;
    if !path.exists() { return Ok(vec![]); }
    let content = safe::text(&path, 64 * 1024).ok_or("exportNamesUnavailable")?;
    Ok(content.lines().map(str::trim).filter(|s| !s.is_empty() && !s.starts_with('#')).map(str::to_owned).collect())
}
fn users(home: &str) -> Vec<String> {
    let mut out = vec![home.replace('\\', "/").trim_end_matches('/').rsplit('/').next().unwrap_or("").to_owned()];
    for key in ["USERNAME", "USER"] {
        if let Ok(name) = std::env::var(key) { if !name.is_empty() { out.push(name); } }
    }
    out
}
fn skill_path(item: &Item, catalog: &Catalog) -> Option<PathBuf> {
    let path = PathBuf::from(item.path.as_ref()?);
    if safe::private(&path) || safe::private(&safe::canonical(&path)) || safe::basename(&path) != "SKILL.md" { return None; }
    let home = Path::new(&catalog.home);
    let roots = [home.join(".claude/skills"), home.join(".codex/skills"), home.join(".agents/skills"), home.join(".claude/plugins"), home.join(".codex/plugins")];
    roots.iter().any(|root| path.starts_with(root) && safe::canonical(&path).starts_with(safe::canonical(root))).then_some(path)
}
fn inputs(mut catalog: Catalog, options: &ExportOptions, home: &Path) -> Result<Catalog, String> {
    // Reuse already-written skill metadata only; never refresh configs or logs.
    if let Some(cache) = safe::json(&home.join(".mycmux/skills/cache.json")) {
        for item in catalog.items.iter_mut().filter(|i| i.kind == "skill") {
            if let Some(row) = cache["skills"].as_array().into_iter().flatten().find(|r| r["docPath"].as_str() == item.path.as_deref()) {
                for key in ["description", "category"] {
                    if let Some(value) = row[key].as_str() { item.fields.push(Field::new(key, value)); }
                }
            }
        }
    }
    // Skill descriptions are declared metadata from an allowed document, not
    // a refresh of settings or conversation records. Read only frontmatter.
    for index in 0..catalog.items.len() {
        if catalog.items[index].kind != "skill" { continue; }
        let path = skill_path(&catalog.items[index], &catalog);
        let item = &mut catalog.items[index];
        if !item.fields.iter().any(|f| f.key == "description") {
            if let Some(header) = path.as_deref().and_then(skill_header) {
                let front = super::frontmatter::parse(&header);
                for key in ["description", "category"] {
                    if let Some(value) = front[key].as_str() { item.fields.push(Field::new(key, value)); }
                }
            }
        }
    }
    for choice in &options.documents {
        let item = catalog.items.iter().find(|i| i.id == choice.id).ok_or("exportDocumentUnavailable")?;
        if !book::allowed(item) { return Err("exportDocumentDenied".into()); }
        let opened = super::full_content::opened(home, Path::new(&catalog.cwd), &catalog, &choice.id, None, 0)?;
        if opened["body"].as_str().is_none() || opened["truncated"].as_bool() == Some(true) { return Err("exportDocumentUnavailable".into()); }
        catalog.documents.insert(choice.id.clone(), opened);
    }
    super::scrub_catalog(&mut catalog);
    Ok(catalog)
}
fn skill_header(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(safe::open(path).ok()?.take(64 * 1024));
    let mut header = String::new();
    reader.read_line(&mut header).ok()?;
    if header.trim() != "---" { return None; }
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 { return None; }
        let closed = line.trim() == "---";
        header.push_str(&line);
        if closed { return Some(header); }
    }
}
fn snapshot(cwd: Option<String>) -> Result<(PathBuf, Catalog), String> {
    let home = super::home()?;
    let cwd = super::cwd_or_home(cwd, &home)?;
    Ok((home.clone(), super::snapshot_or_cached(&home, &cwd)?))
}
fn preview(home: &Path, catalog: Catalog, options: &ExportOptions) -> Result<ExportPreview, String> {
    let catalog = inputs(catalog, options, home)?;
    book::prepare(&catalog, options, &names(home)?, &users(&catalog.home))
}
pub(super) fn save_file(path: &Path, preview: &ExportPreview, home: &Path, protected_roots: &[PathBuf]) -> Result<(), String> {
    if !preview.hits.is_empty() { return Err("exportNamesFound".into()); }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) { return Err("exportPathDenied".into()); }
    let within = |root: &Path| {
        let target = safe::normalized(path);
        let root = safe::normalized(root);
        target == root || target.starts_with(&(root + "/"))
    };
    if !path.is_absolute() || !path.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("html")) || safe::private(path)
        || [".claude", ".codex", ".agents", ".hermes"].iter().any(|p| within(&home.join(p)))
        || protected_roots.iter().any(|p| within(p)) { return Err("exportPathDenied".into()); }
    no_links(path)?;
    let parent = path.parent().filter(|p| p.is_dir()).ok_or("exportFolderUnavailable")?;
    if path.exists() { return Err("exportFileExists".into()); }
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "exportSaveFailed")?;
    file.write_all(preview.html.as_bytes()).map_err(|_| "exportSaveFailed")?;
    file.as_file().sync_all().map_err(|_| "exportSaveFailed")?;
    file.persist_noclobber(path).map_err(|_| "exportSaveFailed")?;
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult { pub saved: bool, pub path: Option<String>, pub preview: ExportPreview }
#[tauri::command]
pub async fn agent_design_export_documents(cwd: Option<String>) -> Result<Vec<SelectableDocument>, String> {
    run_blocking("agent_design_export_documents", move || {
        let (_, catalog) = snapshot(cwd)?; Ok(book::documents(&catalog))
    }).await
}
pub(super) fn recheck(home: &Path, catalog: &Catalog, id: &str) -> Result<SelectableDocument, String> {
    let item = catalog.items.iter().find(|i| i.id == id).ok_or("exportDocumentUnavailable")?;
    if !book::allowed(item) { return Err("exportDocumentDenied".into()); }
    let opened = super::full_content::opened(home, Path::new(&catalog.cwd), catalog, id, None, 0)?;
    let available = opened["body"].is_string() && opened["truncated"].as_bool() != Some(true);
    let reason = if opened["truncated"].as_bool() == Some(true) { Some("truncated".into()) } else { opened["reason"].as_str().map(str::to_owned) };
    let mut current = catalog.clone(); current.documents.insert(id.into(), opened);
    let mut doc = book::documents(&current).into_iter().find(|d| d.id == id).ok_or("exportDocumentUnavailable")?;
    doc.available = available; doc.reason = reason;
    Ok(doc)
}
#[tauri::command]
pub async fn agent_design_export_recheck(cwd: Option<String>, id: String) -> Result<SelectableDocument, String> {
    run_blocking("agent_design_export_recheck", move || {
        let (home, catalog) = snapshot(cwd)?; recheck(&home, &catalog, &id)
    }).await
}
#[tauri::command]
pub async fn agent_design_export_preview(cwd: Option<String>, options: ExportOptions) -> Result<ExportPreview, String> {
    run_blocking("agent_design_export_preview", move || { let (home, catalog) = snapshot(cwd)?; preview(&home, catalog, &options) }).await
}
#[tauri::command]
pub async fn agent_design_export_save(cwd: Option<String>, options: ExportOptions, fingerprint: String, path: String) -> Result<ExportResult, String> {
    run_blocking("agent_design_export_save", move || {
        let (home, catalog) = snapshot(cwd)?;
        let roots = catalog.services.iter().map(|s| PathBuf::from(&s.root)).collect::<Vec<_>>();
        // Rebuild from the current catalogue and re-read the list at the final gate.
        let prepared = preview(&home, catalog, &options)?;
        if !prepared.hits.is_empty() { return Ok(ExportResult { saved: false, path: None, preview: prepared }); }
        if prepared.fingerprint != fingerprint { return Err("exportChanged".into()); }
        save_file(Path::new(&path), &prepared, &home, &roots)?;
        Ok(ExportResult { saved: true, path: Some(path), preview: prepared })
    }).await
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportNames { pub path: String, pub content: String }
#[tauri::command]
pub async fn agent_design_export_names() -> Result<ExportNames, String> {
    run_blocking("agent_design_export_names", move || {
        let home = super::home()?; let path = list_path(&home);
        no_links(&path)?;
        let content = if path.exists() { safe::text(&path, 64 * 1024).ok_or("exportNamesUnavailable")? } else { String::new() };
        Ok(ExportNames { path: path.to_string_lossy().into(), content })
    }).await
}
#[tauri::command]
pub async fn agent_design_export_save_names(content: String) -> Result<(), String> {
    run_blocking("agent_design_export_save_names", move || {
        if content.len() > 64 * 1024 || content.contains('\0') { return Err("exportNamesInvalid".into()); }
        let home = super::home()?; let path = list_path(&home); no_links(&path)?;
        let parent = path.parent().ok_or("exportPathDenied")?;
        std::fs::create_dir_all(parent).map_err(|_| "exportNamesSaveFailed")?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "exportNamesSaveFailed")?;
        file.write_all(content.as_bytes()).map_err(|_| "exportNamesSaveFailed")?;
        file.as_file().sync_all().map_err(|_| "exportNamesSaveFailed")?;
        file.persist(path).map_err(|_| "exportNamesSaveFailed")?;
        Ok(())
    }).await
}
#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
