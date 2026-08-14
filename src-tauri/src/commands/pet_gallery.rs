use crate::commands::pets::{pet_info_from_directory, validate_atlas, PetInfo};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::time::Duration;
use uuid::Uuid;
use zip::ZipArchive;

const GALLERY_ORIGIN: &str = "https://codex-pets.net/";
const MAX_PREVIEW_BYTES: usize = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES: usize = 16 * 1024 * 1024;
const MAX_EXTRACTED_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
const ALLOWED_ARCHIVE_ENTRIES: &[&str] = &["pet.json", "spritesheet.webp", "spritesheet.png"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiValidationReport {
    #[serde(default)]
    atlas_size: String,
    /// codex-pets.net reports the number of detected states, not their names.
    #[serde(default)]
    states_detected: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiPet {
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    like_count: u64,
    #[serde(default)]
    download_count: u64,
    /// The whole animation laid out side by side (thousands of px wide).
    #[serde(default)]
    preview_url: String,
    /// A single frame, which is what a thumbnail wants.
    #[serde(default)]
    poster_url: Option<String>,
    #[serde(default)]
    validation_report: Option<ApiValidationReport>,
}

#[derive(Debug, Deserialize)]
struct ApiPage {
    /// Kept untyped so one entry with a drifted schema cannot blank the whole page.
    #[serde(default)]
    pets: Vec<serde_json::Value>,
    #[serde(default)]
    total: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryPet {
    id: String,
    display_name: String,
    description: String,
    tags: Vec<String>,
    like_count: u64,
    download_count: u64,
    preview_url: String,
    poster_url: Option<String>,
    atlas_size: String,
    states_detected: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryPage {
    pets: Vec<GalleryPet>,
    total: u64,
}

#[derive(Debug, Serialize)]
pub struct QuarantinedPet {
    folder: String,
    name: String,
    atlas_width: Option<u32>,
    atlas_height: Option<u32>,
    rows: Option<u8>,
    valid: bool,
    warning: Option<String>,
}

fn pets_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".codex").join("pets"))
        .ok_or_else(|| "Could not resolve the home directory".to_string())
}

fn ensure_pet_mutation_allowed(profile_active: bool) -> Result<(), String> {
    if profile_active {
        return Err("Pet changes are disabled while a test profile is active".to_string());
    }
    Ok(())
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_safe_folder(folder: &str) -> bool {
    is_safe_id(folder)
        && !folder.starts_with('_')
        && folder != "."
        && folder != ".."
        && Path::new(folder).components().all(|component| matches!(component, Component::Normal(_)))
}

fn epoch_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn unique_target(parent: &Path, folder: &str) -> PathBuf {
    let initial = parent.join(folder);
    if !initial.exists() {
        return initial;
    }
    let timestamp = epoch_seconds();
    for suffix in 0..1000 {
        let candidate = if suffix == 0 {
            parent.join(format!("{folder}-{timestamp}"))
        } else {
            parent.join(format!("{folder}-{timestamp}-{suffix}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{folder}-{timestamp}-{}", Uuid::new_v4()))
}

fn archive_entry_name_is_safe(name: &str) -> bool {
    ALLOWED_ARCHIVE_ENTRIES.contains(&name)
        && Path::new(name).components().count() == 1
        && Path::new(name).components().all(|component| matches!(component, Component::Normal(_)))
}

fn validate_archive_entries(archive: &mut ZipArchive<Cursor<Vec<u8>>>) -> Result<(), String> {
    if archive.len() != 2 {
        return Err("Pet archive must contain exactly pet.json and one spritesheet".to_string());
    }
    let mut entries = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| format!("Could not read pet archive: {error}"))?;
        let name = entry.name();
        if !archive_entry_name_is_safe(name) || entry.enclosed_name().is_none() || entry.is_dir() {
            return Err(format!("Unsafe pet archive entry: {name}"));
        }
        if entry.size() > MAX_EXTRACTED_ENTRY_BYTES || !entries.insert(name.to_string()) {
            return Err(format!("Invalid pet archive entry: {name}"));
        }
    }
    if !entries.contains("pet.json") || !(entries.contains("spritesheet.webp") ^ entries.contains("spritesheet.png")) {
        return Err("Pet archive must contain pet.json and exactly one spritesheet".to_string());
    }
    Ok(())
}

fn read_archive_entry(archive: &mut ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Result<Vec<u8>, String> {
    let entry = archive.by_name(name).map_err(|error| format!("Pet archive entry {name} is missing: {error}"))?;
    if entry.size() > MAX_EXTRACTED_ENTRY_BYTES {
        return Err(format!("Pet archive entry {name} is too large"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.take(MAX_EXTRACTED_ENTRY_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read pet archive entry {name}: {error}"))?;
    if bytes.len() as u64 > MAX_EXTRACTED_ENTRY_BYTES {
        return Err(format!("Pet archive entry {name} is too large"));
    }
    Ok(bytes)
}

async fn bounded_bytes(response: reqwest::Response, limit: usize, label: &str) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|size| size > limit as u64) {
        return Err(format!("{label} exceeds the size limit"));
    }
    let bytes = response.bytes().await.map_err(|error| format!("Could not read {label}: {error}"))?;
    if bytes.len() > limit {
        return Err(format!("{label} exceeds the size limit"));
    }
    Ok(bytes.to_vec())
}

fn quarantine_at(root: &Path, folder: &str) -> Result<String, String> {
    if !is_safe_folder(folder) {
        return Err("Invalid pet folder".to_string());
    }
    let source = root.join(folder);
    if !source.is_dir() {
        return Err("Pet folder was not found".to_string());
    }
    let disabled = root.join("_disabled");
    fs::create_dir_all(&disabled).map_err(|error| format!("Could not create quarantine directory: {error}"))?;
    let destination = unique_target(&disabled, folder);
    fs::rename(&source, &destination).map_err(|error| format!("Could not quarantine pet: {error}"))?;
    Ok(destination.file_name().unwrap_or_default().to_string_lossy().into_owned())
}

fn restore_at(root: &Path, folder: &str) -> Result<(), String> {
    if !is_safe_folder(folder) {
        return Err("Invalid pet folder".to_string());
    }
    let source = root.join("_disabled").join(folder);
    if !source.is_dir() {
        return Err("Quarantined pet folder was not found".to_string());
    }
    let destination = unique_target(root, folder);
    fs::rename(&source, &destination).map_err(|error| format!("Could not restore pet: {error}"))
}

fn list_quarantined_at(root: &Path) -> Vec<QuarantinedPet> {
    let Ok(entries) = fs::read_dir(root.join("_disabled")) else { return Vec::new(); };
    entries.flatten().filter_map(|entry| {
        if !entry.file_type().ok()?.is_dir() { return None; }
        let folder = entry.file_name().to_string_lossy().into_owned();
        let info = pet_info_from_directory(folder.clone(), &entry.path());
        Some(QuarantinedPet {
            folder,
            name: info.name,
            atlas_width: info.atlas_width,
            atlas_height: info.atlas_height,
            rows: info.rows,
            valid: info.valid,
            warning: info.warning,
        })
    }).collect()
}

fn install_archive_at(root: &Path, id: String, bytes: Vec<u8>) -> Result<PetInfo, String> {
    if !is_safe_id(&id) {
        return Err("Invalid pet id".to_string());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("Could not open pet archive: {error}"))?;
    validate_archive_entries(&mut archive)?;
    let manifest = read_archive_entry(&mut archive, "pet.json")?;
    let atlas_name = if archive.by_name("spritesheet.webp").is_ok() { "spritesheet.webp" } else { "spritesheet.png" };
    let atlas = read_archive_entry(&mut archive, atlas_name)?;
    let dimensions = imagesize::blob_size(&atlas).map_err(|error| format!("Could not read atlas dimensions: {error}"))?;
    validate_atlas(dimensions.width as u32, dimensions.height as u32)?;
    let manifest_value: serde_json::Value = serde_json::from_slice(&manifest).map_err(|error| format!("Invalid pet manifest: {error}"))?;
    let manifest_id = manifest_value.get("id").and_then(|value| value.as_str()).unwrap_or(&id);
    if manifest_id != id {
        return Err("Pet manifest id does not match download id".to_string());
    }
    fs::create_dir_all(root).map_err(|error| format!("Could not create pet directory: {error}"))?;
    let temporary = root.join(format!(".tmp-{}", Uuid::new_v4()));
    fs::create_dir(&temporary).map_err(|error| format!("Could not create temporary pet directory: {error}"))?;
    fs::write(temporary.join("pet.json"), manifest).map_err(|error| format!("Could not save pet manifest: {error}"))?;
    fs::write(temporary.join(atlas_name), atlas).map_err(|error| format!("Could not save pet atlas: {error}"))?;
    let destination = root.join(&id);
    if destination.exists() {
        let disabled = root.join("_disabled");
        fs::create_dir_all(&disabled).map_err(|error| format!("Could not create quarantine directory: {error}"))?;
        let backup = unique_target(&disabled, &id);
        fs::rename(&destination, &backup).map_err(|error| format!("Could not back up existing pet: {error}"))?;
    }
    fs::rename(&temporary, &destination).map_err(|error| format!("Could not install pet: {error}"))?;
    Ok(pet_info_from_directory(id, &destination))
}

const GALLERY_SORTS: &[&str] = &["new", "popular", "trending", "downloads"];

fn gallery_sort(sort: Option<String>) -> String {
    sort.filter(|value| GALLERY_SORTS.contains(&value.as_str())).unwrap_or_else(|| "new".to_string())
}

fn parse_gallery_page(body: &[u8]) -> Result<GalleryPage, String> {
    let page: ApiPage = serde_json::from_slice(body).map_err(|error| format!("Invalid gallery response: {error}"))?;
    let pets = page.pets.into_iter().filter_map(|value| {
        // Drop only the entries whose schema drifted, never the whole page.
        let pet: ApiPet = serde_json::from_value(value).ok()?;
        let report = pet.validation_report.unwrap_or(ApiValidationReport { atlas_size: String::new(), states_detected: 0 });
        Some(GalleryPet { id: pet.id, display_name: pet.display_name, description: pet.description, tags: pet.tags, like_count: pet.like_count, download_count: pet.download_count, preview_url: pet.preview_url, poster_url: pet.poster_url, atlas_size: report.atlas_size, states_detected: report.states_detected })
    }).collect();
    Ok(GalleryPage { pets, total: page.total })
}

#[tauri::command(async)]
pub async fn fetch_pet_gallery(query: Option<String>, page: u32, page_size: u32, sort: Option<String>) -> Result<GalleryPage, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build()
        .map_err(|error| format!("Could not initialize gallery client: {error}"))?;
    let page = page.max(1);
    let response = client.get("https://codex-pets.net/api/pets")
        .query(&[("page", page.to_string()), ("pageSize", page_size.clamp(1, 48).to_string()), ("sort", gallery_sort(sort)), ("q", query.unwrap_or_default())])
        .send().await.map_err(|error| format!("Could not fetch pet gallery: {error}"))?
        .error_for_status().map_err(|error| format!("Could not fetch pet gallery: {error}"))?;
    let body = response.bytes().await.map_err(|error| format!("Could not read gallery response: {error}"))?;
    parse_gallery_page(&body)
}

#[tauri::command(async)]
pub async fn fetch_pet_preview(preview_url: String) -> Result<String, String> {
    if !preview_url.starts_with(GALLERY_ORIGIN) { return Err("Preview URL must use codex-pets.net".to_string()); }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none()).build()
        .map_err(|error| format!("Could not initialize gallery client: {error}"))?;
    let response = client.get(&preview_url).send().await.map_err(|error| format!("Could not fetch pet preview: {error}"))?
        .error_for_status().map_err(|error| format!("Could not fetch pet preview: {error}"))?;
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("image/webp").to_string();
    let bytes = bounded_bytes(response, MAX_PREVIEW_BYTES, "Pet preview").await?;
    Ok(format!("data:{content_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command(async)]
pub async fn install_pet_from_gallery(id: String) -> Result<PetInfo, String> {
    ensure_pet_mutation_allowed(crate::test_profile::is_active())?;
    if !is_safe_id(&id) { return Err("Invalid pet id".to_string()); }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none()).build()
        .map_err(|error| format!("Could not initialize gallery client: {error}"))?;
    let response = client.get(format!("https://codex-pets.net/api/pets/{id}/download")).send().await
        .map_err(|error| format!("Could not download pet: {error}"))?.error_for_status().map_err(|error| format!("Could not download pet: {error}"))?;
    let bytes = bounded_bytes(response, MAX_DOWNLOAD_BYTES, "Pet download").await?;
    let root = pets_root()?;
    tokio::task::spawn_blocking(move || install_archive_at(&root, id, bytes)).await.map_err(|error| format!("Pet installation task failed: {error}"))?
}

#[tauri::command(async)]
pub async fn quarantine_pet(folder: String) -> Result<String, String> {
    ensure_pet_mutation_allowed(crate::test_profile::is_active())?;
    let root = pets_root()?;
    tokio::task::spawn_blocking(move || quarantine_at(&root, &folder)).await.map_err(|error| format!("Pet quarantine task failed: {error}"))?
}

#[tauri::command(async)]
pub async fn restore_pet(folder: String) -> Result<(), String> {
    ensure_pet_mutation_allowed(crate::test_profile::is_active())?;
    let root = pets_root()?;
    tokio::task::spawn_blocking(move || restore_at(&root, &folder)).await.map_err(|error| format!("Pet restore task failed: {error}"))?
}

#[tauri::command(async)]
pub async fn list_quarantined_pets() -> Result<Vec<QuarantinedPet>, String> {
    let root = pets_root()?;
    tokio::task::spawn_blocking(move || Ok::<_, String>(list_quarantined_at(&root))).await.map_err(|error| format!("Pet list task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_entry_names_reject_path_traversal() {
        assert!(!archive_entry_name_is_safe("../evil"));
        assert!(!archive_entry_name_is_safe("a/b.webp"));
        assert!(archive_entry_name_is_safe("spritesheet.webp"));
    }

    #[test]
    fn folder_sanitizer_rejects_special_and_hidden_names() {
        assert!(is_safe_folder("kurisu-v2"));
        assert!(!is_safe_folder(".."));
        assert!(!is_safe_folder("a/b"));
        assert!(!is_safe_folder("_disabled"));
    }

    #[test]
    fn gallery_page_parses_numeric_states_detected() {
        // codex-pets.net returns statesDetected as a count; the array shape blanked the gallery.
        let body = br#"{"pets":[{"id":"twix-snickers","displayName":"Twix & Snickers","description":"d",
            "tags":["animated","cute"],"likeCount":3,"downloadCount":7,
            "previewUrl":"https://codex-pets.net/assets/pets/v/1/twix-snickers/preview.webp",
            "posterUrl":"https://codex-pets.net/assets/pets/v/1/twix-snickers/poster.webp",
            "validationReport":{"atlasSize":"1536x2288","statesDetected":11,"cellSize":"192x208"}}],
            "page":1,"pageSize":24,"total":3029,"totalPages":127}"#;
        let page = parse_gallery_page(body).expect("page should parse");
        assert_eq!(page.total, 3029);
        assert_eq!(page.pets.len(), 1);
        assert_eq!(page.pets[0].atlas_size, "1536x2288");
        assert_eq!(page.pets[0].states_detected, 11);
        // The thumbnail needs the single frame; previewUrl is a 7008x104 filmstrip.
        assert_eq!(page.pets[0].poster_url.as_deref(), Some("https://codex-pets.net/assets/pets/v/1/twix-snickers/poster.webp"));
    }

    #[test]
    fn profile_rejects_every_pet_mutation_before_touching_the_shared_root() {
        assert!(ensure_pet_mutation_allowed(false).is_ok());
        assert!(ensure_pet_mutation_allowed(true).is_err());
    }

    #[test]
    fn gallery_page_keeps_pet_when_poster_url_is_null() {
        let body = br#"{"pets":[{"id":"preview-only","previewUrl":"https://codex-pets.net/preview.webp","posterUrl":null}],"total":1}"#;
        let page = parse_gallery_page(body).expect("page should parse");
        assert_eq!(page.pets.len(), 1);
        assert_eq!(page.pets[0].preview_url, "https://codex-pets.net/preview.webp");
        assert!(page.pets[0].poster_url.is_none());
    }

    #[test]
    fn gallery_page_keeps_valid_pets_when_one_entry_is_broken() {
        let body = br#"{"pets":[{"id":"ok-one"},{"displayName":"missing id"},{"id":"ok-two","validationReport":null}],"total":3}"#;
        let page = parse_gallery_page(body).expect("page should parse");
        assert_eq!(page.total, 3);
        assert_eq!(page.pets.iter().map(|pet| pet.id.as_str()).collect::<Vec<_>>(), vec!["ok-one", "ok-two"]);
        assert_eq!(page.pets[1].states_detected, 0);
    }

    #[test]
    fn gallery_sort_falls_back_to_new() {
        assert_eq!(gallery_sort(Some("popular".to_string())), "popular");
        assert_eq!(gallery_sort(Some("; drop".to_string())), "new");
        assert_eq!(gallery_sort(None), "new");
    }

    #[test]
    fn quarantine_target_adds_suffix_on_collision() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("kurisu")).unwrap();
        let candidate = unique_target(root.path(), "kurisu");
        assert_ne!(candidate, root.path().join("kurisu"));
        assert!(candidate.file_name().unwrap().to_string_lossy().starts_with("kurisu-"));
    }
}
