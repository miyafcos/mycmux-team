mod install;
mod pack_rules;
mod prereq;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
include!(concat!(env!("OUT_DIR"), "/claude_skills_pack.rs"));

#[derive(Deserialize)]
pub(super) struct Manifest {
    pack_version: String,
    skills: Vec<Entry>,
    cli: CliEntry,
}
#[derive(Deserialize)]
pub(super) struct Entry {
    name: String,
    files: BTreeMap<String, String>,
}
#[derive(Deserialize)]
pub(super) struct CliEntry {
    sha256: String,
}
#[derive(Serialize)]
pub struct SkillStatus {
    name: String,
    state: String,
    installed_version: Option<String>,
}
#[derive(Serialize)]
pub struct CliStatus {
    state: String,
}
#[derive(Serialize)]
pub struct PackStatus {
    pack_version: String,
    skills: Vec<SkillStatus>,
    cli: CliStatus,
    prereq: prereq::Prerequisites,
    home: String,
}
#[derive(Default, Debug, Serialize)]
pub struct InstallResult {
    installed: Vec<String>,
    skipped: Vec<String>,
    backups: Vec<String>,
    errors: Vec<String>,
}
fn manifest() -> Result<Manifest, String> {
    serde_json::from_slice(PACK_MANIFEST).map_err(|e| format!("invalid embedded manifest: {e}"))
}
fn status_at(home: &Path, prereq: prereq::Prerequisites) -> Result<PackStatus, String> {
    let manifest = manifest()?;
    let skills = manifest
        .skills
        .iter()
        .map(|entry| {
            let dest = home.join(".claude/skills").join(&entry.name);
            let marker = std::fs::read(dest.join(install::MARKER))
                .ok()
                .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok());
            SkillStatus {
                name: entry.name.clone(),
                state: install::state(&dest, entry, &manifest.pack_version).into(),
                installed_version: marker
                    .as_ref()
                    .and_then(|v| v.get("pack_version"))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned),
            }
        })
        .collect();
    let cli = CliStatus {
        state: install::cli_state(home, &manifest)?.into(),
    };
    Ok(PackStatus {
        pack_version: manifest.pack_version,
        skills,
        cli,
        prereq,
        home: home.to_string_lossy().into_owned(),
    })
}
#[tauri::command]
pub async fn claude_skills_status() -> Result<PackStatus, String> {
    let home = dirs::home_dir().ok_or("home directory is not available")?;
    let prereq = prereq::check().await;
    tauri::async_runtime::spawn_blocking(move || status_at(&home, prereq))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn claude_skills_install(
    names: Vec<String>,
    force: bool,
) -> Result<InstallResult, String> {
    let home = dirs::home_dir().ok_or("home directory is not available")?;
    // Serialize preflight and rename across settings windows.
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || install::install_at(&home, &names, force))
        .await
        .map_err(|e| e.to_string())
}
