mod atomic;
mod claude;
mod codex;
mod json_splice;
mod registry;
mod snapshot;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use std::{fs, path::Path};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum CliProvider { Claude, Codex }
#[derive(Serialize, Deserialize, Clone)]
pub struct CliAccountProfile { pub id:String, pub provider:CliProvider, pub label:String, #[serde(default)] pub email:Option<String>, pub identity_key:String, #[serde(default)] pub plan:Option<String>, #[serde(default)] pub org_name:Option<String>, pub captured_at:String, #[serde(default)] pub last_switched_at:Option<String>, #[serde(default)] pub needs_relogin:bool }
#[derive(Serialize, Clone)]
pub struct CliLiveLogin { pub provider:CliProvider, pub present:bool, pub email:Option<String>, pub identity_key:Option<String>, pub plan:Option<String>, pub org_name:Option<String>, pub matched_profile_id:Option<String>, pub error:Option<String> }
#[derive(Serialize)] pub struct CliAccountsSnapshot { pub profiles:Vec<CliAccountProfile>, pub live:Vec<CliLiveLogin>, pub generated_at:String }
#[derive(Serialize)] pub struct CliSwitchResult { pub profile:CliAccountProfile, pub wrote_back_to:Option<String>, pub backup_dir:String, pub warnings:Vec<String> }
fn paths_for<'a>(provider:CliProvider, claude_paths:&'a claude::ClaudePaths, codex_paths:&'a codex::CodexPaths)->Vec<&'a Path>{match provider{CliProvider::Claude=>vec![claude_paths.credentials.as_path(),claude_paths.claude_json.as_path()],CliProvider::Codex=>vec![codex_paths.auth.as_path()]}}
fn match_live(mut live:CliLiveLogin, profiles:&[CliAccountProfile])->CliLiveLogin {if let Some(key)=live.identity_key.as_deref(){live.matched_profile_id=profiles.iter().find(|p|p.provider==live.provider&&p.identity_key==key).map(|p|p.id.clone());}live}
pub fn list(base:&Path, claude_paths:&claude::ClaudePaths, codex_paths:&codex::CodexPaths)->Result<CliAccountsSnapshot,String>{let file=registry::load(base)?;Ok(CliAccountsSnapshot{profiles:file.profiles.clone(),live:vec![match_live(claude::read_live_identity(claude_paths),&file.profiles),match_live(codex::read_live_identity(codex_paths),&file.profiles)],generated_at:Utc::now().to_rfc3339()})}
pub fn capture_account(base:&Path, claude_paths:&claude::ClaudePaths, codex_paths:&codex::CodexPaths, provider:CliProvider, label:Option<String>)->Result<CliAccountProfile,String>{let (stored,live)=match provider{CliProvider::Claude=>{let(s,l)=claude::capture(claude_paths)?;(snapshot::StoredSnapshot::Claude(s),l)},CliProvider::Codex=>{let(s,l)=codex::capture(codex_paths)?;(snapshot::StoredSnapshot::Codex(s),l)}};let identity=live.identity_key.clone().ok_or_else(||"Live login has no identity".to_string())?;let mut file=registry::load(base)?;let existing=file.profiles.iter().find(|p|p.provider==provider&&p.identity_key==identity).cloned();let id=existing.as_ref().map(|p|p.id.clone()).unwrap_or_else(||format!("{}-{}",match provider{CliProvider::Claude=>"claude",CliProvider::Codex=>"codex"},Uuid::new_v4().simple().to_string()[..8].to_string()));let profile=CliAccountProfile{id:id.clone(),provider,label:label.or_else(||existing.as_ref().map(|p|p.label.clone())).unwrap_or_else(||live.email.clone().unwrap_or_else(||identity.chars().take(8).collect())),email:live.email,identity_key:identity,plan:live.plan,org_name:live.org_name,captured_at:Utc::now().to_rfc3339(),last_switched_at:existing.and_then(|p|p.last_switched_at),needs_relogin:match &stored {snapshot::StoredSnapshot::Claude(s)=>claude::needs_relogin(&s.credentials_text),snapshot::StoredSnapshot::Codex(_)=>false}};snapshot::save(base,&id,&stored)?;registry::upsert_by_identity_key(&mut file,profile.clone());registry::save(base,&file)?;Ok(profile)}
pub fn switch_account(base:&Path, claude_paths:&claude::ClaudePaths, codex_paths:&codex::CodexPaths, provider:CliProvider, profile_id:&str)->Result<CliSwitchResult,String>{let mut file=registry::load(base)?;let target=file.profiles.iter().find(|p|p.id==profile_id&&p.provider==provider).cloned().ok_or_else(||"CLI account profile was not found".to_string())?;let live=match provider {CliProvider::Claude=>claude::read_live_identity(claude_paths),CliProvider::Codex=>codex::read_live_identity(codex_paths)};let mut warnings=Vec::new();let mut wrote_back_to=None;if live.present {let (current,id)=match provider{CliProvider::Claude=>{let(s,_)=claude::capture(claude_paths)?;(snapshot::StoredSnapshot::Claude(s),live.identity_key.clone())},CliProvider::Codex=>{let(s,_)=codex::capture(codex_paths)?;(snapshot::StoredSnapshot::Codex(s),live.identity_key.clone())}};if let Some(identity)=id {if let Some(profile)=file.profiles.iter().find(|p|p.provider==provider&&p.identity_key==identity){snapshot::save(base,&profile.id,&current)?;wrote_back_to=Some(profile.id.clone());if profile.id==target.id{warnings.push("Switching to the active profile refreshed its snapshot".into());}}else{snapshot::save_orphan(base,provider,&current)?;warnings.push("Current live login was unregistered; saved an orphan snapshot".into());}}}
let stored=snapshot::load(base,&target.id)?;match (&stored,provider){(snapshot::StoredSnapshot::Claude(s),CliProvider::Claude)=>{serde_json::from_str::<serde_json::Value>(&s.credentials_text).map_err(|_|"Claude snapshot credentials are invalid".to_string())?;if claude::needs_relogin(&s.credentials_text){return Err("要再ログイン".to_string())}},(snapshot::StoredSnapshot::Codex(s),CliProvider::Codex)=>{let v:serde_json::Value=serde_json::from_str(&s.auth_text).map_err(|_|"Codex snapshot is invalid".to_string())?;if v.get("tokens").is_none(){return Err("Codex snapshot has no tokens".into())}},_=>return Err("Snapshot provider does not match profile".into())};let backup=snapshot::backup_live_files(base,&paths_for(provider,claude_paths,codex_paths))?;match stored{snapshot::StoredSnapshot::Claude(s)=>claude::restore(claude_paths,&s)?,snapshot::StoredSnapshot::Codex(s)=>codex::restore(codex_paths,&s)?};let verified=match provider{CliProvider::Claude=>claude::read_live_identity(claude_paths),CliProvider::Codex=>codex::read_live_identity(codex_paths)};if verified.identity_key.as_deref()!=Some(target.identity_key.as_str()){warnings.push("Restored login identity did not match the target profile".into());}let now=Utc::now().to_rfc3339();if let Some(p)=file.profiles.iter_mut().find(|p|p.id==target.id){p.last_switched_at=Some(now);};registry::set_active(&mut file,provider,Some(target.id.clone()));registry::save(base,&file)?;let profile=file.profiles.iter().find(|p|p.id==target.id).cloned().unwrap_or(target);Ok(CliSwitchResult{profile,wrote_back_to,backup_dir:backup.display().to_string(),warnings})}

pub fn list_resolved(base: &Path) -> Result<CliAccountsSnapshot, String> {
    let claude_paths = claude::ClaudePaths::resolve()?;
    let codex_paths = codex::CodexPaths::resolve()?;
    list(base, &claude_paths, &codex_paths)
}

pub fn capture_resolved(base: &Path, provider: CliProvider, label: Option<String>) -> Result<CliAccountProfile, String> {
    let claude_paths = claude::ClaudePaths::resolve()?;
    let codex_paths = codex::CodexPaths::resolve()?;
    capture_account(base, &claude_paths, &codex_paths, provider, label)
}

pub fn switch_resolved(base: &Path, provider: CliProvider, profile_id: &str) -> Result<CliSwitchResult, String> {
    let claude_paths = claude::ClaudePaths::resolve()?;
    let codex_paths = codex::CodexPaths::resolve()?;
    switch_account(base, &claude_paths, &codex_paths, provider, profile_id)
}

pub fn remove_resolved(base: &Path, profile_id: &str) -> Result<(), String> {
    let mut file = registry::load(base)?;
    if !registry::remove_profile(&mut file, profile_id) {
        return Err("CLI account profile was not found".into());
    }
    registry::save(base, &file)?;
    let snapshot_path = snapshot::snapshot_dir(base).join(format!("{profile_id}.json"));
    if snapshot_path.is_file() {
        fs::remove_file(&snapshot_path).map_err(|e| format!("Failed to delete snapshot: {e}"))?;
    }
    Ok(())
}

pub fn rename_resolved(base: &Path, profile_id: &str, label: String) -> Result<CliAccountProfile, String> {
    let mut file = registry::load(base)?;
    if !registry::rename_profile(&mut file, profile_id, label) {
        return Err("CLI account profile was not found".into());
    }
    let profile = file.profiles.iter().find(|p| p.id == profile_id).cloned().ok_or_else(|| "CLI account profile was not found".to_string())?;
    registry::save(base, &file)?;
    Ok(profile)
}

#[cfg(test)] mod tests;
