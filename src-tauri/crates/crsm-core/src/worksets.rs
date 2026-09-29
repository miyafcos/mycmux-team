use crate::models::{RestorePlan, Workset};
use crate::path_norm::{crsm_dir, home_dir};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum WorksetError {
    #[error("failed to resolve home directory")]
    NoHome,
    #[error("{0}")]
    Io(String),
}

fn worksets_dir(home: &Path) -> PathBuf {
    crsm_dir(home).join("worksets")
}

pub fn workset_path(name: &str) -> Result<PathBuf, WorksetError> {
    let home = home_dir().ok_or(WorksetError::NoHome)?;
    let safe_name = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>();
    Ok(worksets_dir(&home).join(format!("{safe_name}.json")))
}

pub fn list_worksets() -> Result<Vec<String>, WorksetError> {
    let home = home_dir().ok_or(WorksetError::NoHome)?;
    let dir = worksets_dir(&home);
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(Vec::new());
    };
    let mut names = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                return None;
            }
            path.file_stem()
                .map(|value| value.to_string_lossy().to_string())
        })
        .collect::<Vec<_>>();
    names.sort();
    Ok(names)
}

pub fn load_workset(name: &str) -> Result<Workset, WorksetError> {
    let path = workset_path(name)?;
    let contents = fs::read_to_string(&path)
        .map_err(|error| WorksetError::Io(format!("read {}: {error}", path.display())))?;
    serde_json::from_str(&contents)
        .map_err(|error| WorksetError::Io(format!("parse {}: {error}", path.display())))
}

pub fn save_workset(workset: &Workset) -> Result<PathBuf, WorksetError> {
    let path = workset_path(&workset.name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| WorksetError::Io(format!("create workset dir: {error}")))?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(workset)
        .map_err(|error| WorksetError::Io(format!("serialize workset: {error}")))?;
    fs::write(&tmp_path, json)
        .map_err(|error| WorksetError::Io(format!("write {}: {error}", tmp_path.display())))?;
    fs::rename(&tmp_path, &path)
        .map_err(|error| WorksetError::Io(format!("replace {}: {error}", path.display())))?;
    Ok(path)
}

pub fn restore_plan(name: &str) -> Result<RestorePlan, WorksetError> {
    let workset = load_workset(name)?;
    Ok(RestorePlan {
        schema_version: workset.schema_version,
        name: workset.name,
        entries: workset.entries,
        layout: workset.layout,
    })
}
