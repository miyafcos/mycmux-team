mod catalog;
mod detail;
mod files;
mod frontmatter;
#[cfg(test)]
mod tests;

use crate::util::task::run_blocking;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static SNAPSHOT: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "homeUnavailable".to_owned())
}
fn shared(home: &Path) -> PathBuf {
    home.join(".mycmux/skills")
}
fn cache_dir(home: &Path) -> Result<PathBuf, String> {
    if crate::test_profile::is_active() {
        Ok(crate::test_profile::runtime_dir()?.join("skills"))
    } else {
        Ok(shared(home))
    }
}
fn snapshot() -> Result<Value, String> {
    if let Some(value) = SNAPSHOT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
    {
        return Ok(value);
    }
    let root = home()?;
    Ok(catalog::collect(
        &root,
        &shared(&root),
        serde_json::from_str(catalog::DEFAULTS).map_err(|e| e.to_string())?,
    ))
}
fn document(id: &str) -> Result<PathBuf, String> {
    let snapshot = snapshot()?;
    let row = snapshot["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(snapshot["hiddenSkills"].as_array().into_iter().flatten())
        .find(|r| r["id"] == id)
        .ok_or("skillNotFound")?;
    let path = PathBuf::from(row["docPath"].as_str().ok_or("skillHasNoFiles")?);
    if files::private_path(&path) {
        return Err("fileDenied".to_owned());
    }
    Ok(path)
}

#[tauri::command]
pub async fn skills_cached() -> Result<Value, String> {
    run_blocking("skills_cached", move || {
        if let Some(value) = SNAPSHOT
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
        {
            return Ok(value);
        }
        let value = catalog::read_json(&cache_dir(&home()?)?.join("cache.json"));
        if value["schemaVersion"] == 1 && value["skills"].is_array() {
            Ok(value)
        } else {
            Ok(Value::Null)
        }
    })
    .await
}
#[tauri::command]
pub async fn skills_refresh() -> Result<Value, String> {
    run_blocking("skills_refresh", move || {
        let root = home()?;
        let directory = cache_dir(&root)?;
        let mut value = catalog::collect(
            &root,
            &shared(&root),
            serde_json::from_str(catalog::DEFAULTS).map_err(|e| e.to_string())?,
        );
        value["schemaVersion"] = serde_json::json!(1);
        *SNAPSHOT
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|e| e.to_string())? = Some(value.clone());
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        temporary
            .write_all(
                serde_json::to_string(&value)
                    .map_err(|e| e.to_string())?
                    .as_bytes(),
            )
            .map_err(|e| e.to_string())?;
        temporary
            .persist(directory.join("cache.json"))
            .map_err(|e| e.to_string())?;
        Ok(value)
    })
    .await
}
#[tauri::command]
pub async fn skills_document(id: String) -> Result<Value, String> {
    run_blocking("skills_document", move || {
        Ok(detail::content(&document(&id)?))
    })
    .await
}
#[tauri::command]
pub async fn skills_folder(id: String) -> Result<Value, String> {
    run_blocking("skills_folder", move || files::plan(&document(&id)?, &id)).await
}
#[tauri::command]
pub async fn skills_preview(id: String, relative: String) -> Result<Value, String> {
    run_blocking("skills_preview", move || {
        let mut view = files::preview(&document(&id)?, &id, &relative)?;
        if view["kind"] == "md" {
            view["html"] =
                serde_json::json!(detail::markdown(view["content"].as_str().unwrap_or("")));
        }
        Ok(view)
    })
    .await
}
#[tauri::command]
pub async fn skills_locations(id: String) -> Result<Value, String> {
    run_blocking("skills_locations", move || {
        Ok(detail::locations(&home()?, &id))
    })
    .await
}
#[tauri::command]
pub async fn skills_diff(id: String, left: usize, right: usize) -> Result<Value, String> {
    run_blocking("skills_diff", move || {
        let places = detail::locations(&home()?, &id);
        let items = places["items"].as_array().ok_or("locationNotFound")?;
        let path = |index: usize| {
            items
                .get(index)
                .and_then(|v| v["path"].as_str())
                .map(PathBuf::from)
                .ok_or_else(|| "locationNotFound".to_owned())
        };
        Ok(detail::diff(
            &catalog::text(&path(left)?),
            &catalog::text(&path(right)?),
        ))
    })
    .await
}
#[tauri::command]
pub async fn skills_export(
    id: String,
    paths: Vec<String>,
    destination: String,
) -> Result<String, String> {
    run_blocking("skills_export", move || {
        files::make_zip(&document(&id)?, &id, &paths, Path::new(&destination))?;
        Ok(destination)
    })
    .await
}
