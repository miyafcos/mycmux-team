use std::{fs, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use super::{atomic::write_atomic, CliAccountProfile, CliProvider};
const FILE: &str = "cli_accounts.json";
#[derive(Serialize, Deserialize, Default, Clone)] pub struct ActivePointers { #[serde(default)] pub claude: Option<String>, #[serde(default)] pub codex: Option<String>, #[serde(default)] pub grok: Option<String> }
#[derive(Serialize, Deserialize, Default, Clone)] pub struct CliAccountsFile { #[serde(default)] pub version: u32, #[serde(default)] pub profiles: Vec<CliAccountProfile>, #[serde(default)] pub active: ActivePointers }
pub fn path(base: &Path) -> PathBuf { base.join(FILE) }
pub fn load(base: &Path) -> Result<CliAccountsFile, String> { let p=path(base); if !p.exists() { return Ok(CliAccountsFile::default()); } serde_json::from_str(&fs::read_to_string(&p).map_err(|e| format!("Failed to read registry: {e}"))?).map_err(|e| format!("Failed to parse registry: {e}")) }
pub fn save(base: &Path, file: &CliAccountsFile) -> Result<(), String> { let text=serde_json::to_string_pretty(file).map_err(|e| format!("Failed to serialize registry: {e}"))?; write_atomic(&path(base), text.as_bytes()) }
pub fn upsert_by_identity_key(file: &mut CliAccountsFile, profile: CliAccountProfile) { if let Some(old)=file.profiles.iter_mut().find(|p| p.provider==profile.provider && p.identity_key==profile.identity_key) { let label=old.label.clone(); let last=old.last_switched_at.clone(); *old=profile; old.label=label; old.last_switched_at=last; } else { file.profiles.push(profile); } }
pub fn remove_profile(file: &mut CliAccountsFile, id: &str) -> bool { let before=file.profiles.len(); file.profiles.retain(|p|p.id!=id); if file.active.claude.as_deref()==Some(id){file.active.claude=None;} if file.active.codex.as_deref()==Some(id){file.active.codex=None;} if file.active.grok.as_deref()==Some(id){file.active.grok=None;} before != file.profiles.len() }
pub fn rename_profile(file: &mut CliAccountsFile, id: &str, label: String) -> bool { if let Some(p)=file.profiles.iter_mut().find(|p|p.id==id){p.label=label;true}else{false} }
pub fn set_active(file: &mut CliAccountsFile, provider: CliProvider, id: Option<String>) { match provider { CliProvider::Claude=>file.active.claude=id, CliProvider::Codex=>file.active.codex=id, CliProvider::Grok=>file.active.grok=id } }
