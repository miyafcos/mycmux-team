use std::{fs, path::{Path, PathBuf}};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use super::{atomic::write_atomic, CliProvider};
#[derive(Serialize, Deserialize, Clone)] pub struct ClaudeSnapshot { pub version:u32, pub provider:CliProvider, pub captured_at:String, pub credentials_text:String, pub oauth_account_text:String }
#[derive(Serialize, Deserialize, Clone)] pub struct CodexSnapshot { pub version:u32, pub provider:CliProvider, pub captured_at:String, pub auth_text:String }
#[derive(Serialize, Deserialize, Clone)] #[serde(untagged)] pub enum StoredSnapshot { Claude(ClaudeSnapshot), Codex(CodexSnapshot) }
pub fn snapshot_dir(base:&Path)->PathBuf {base.join("cli_account_snapshots")}
pub fn save(base:&Path,id:&str,snapshot:&StoredSnapshot)->Result<PathBuf,String>{let p=snapshot_dir(base).join(format!("{id}.json"));let text=serde_json::to_string(snapshot).map_err(|e|format!("Failed to serialize snapshot: {e}"))?;write_atomic(&p,text.as_bytes())?;Ok(p)}
pub fn load(base:&Path,id:&str)->Result<StoredSnapshot,String>{let p=snapshot_dir(base).join(format!("{id}.json"));serde_json::from_str(&fs::read_to_string(p).map_err(|e|format!("Failed to read snapshot: {e}"))?).map_err(|e|format!("Failed to parse snapshot: {e}"))}
pub fn save_orphan(base:&Path, provider:CliProvider, snapshot:&StoredSnapshot)->Result<PathBuf,String>{let stamp=Utc::now().to_rfc3339().replace(':',"-");save(base,&format!("unregistered-{}-{stamp}",match provider {CliProvider::Claude=>"claude",CliProvider::Codex=>"codex"}),snapshot)}
pub fn backup_live_files(base:&Path, paths:&[&Path])->Result<PathBuf,String>{let stamp=Utc::now().format("%Y%m%dT%H%M%S%.3fZ").to_string();let dir=base.join("cli_account_backups").join(stamp);fs::create_dir_all(&dir).map_err(|e|format!("Failed to create backup directory: {e}"))?;for p in paths {if p.is_file(){let name=p.file_name().ok_or_else(||"Live file has no name".to_string())?;fs::copy(p,dir.join(name)).map_err(|e|format!("Failed to copy live file: {e}"))?;}}let root=base.join("cli_account_backups");let mut dirs:Vec<_>=fs::read_dir(&root).map_err(|e|format!("Failed to read backups: {e}"))?.flatten().filter(|e|e.path().is_dir()).collect();dirs.sort_by_key(|e|e.file_name());let excess=dirs.len().saturating_sub(10);for e in dirs.into_iter().take(excess){fs::remove_dir_all(e.path()).map_err(|er|format!("Failed to rotate backup: {er}"))?;}Ok(dir)}
