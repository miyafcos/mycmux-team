use serde::Serialize;
use std::fs;
use std::path::PathBuf;

use tauri::State;

use crate::db::storage::{self, PinnedRoot};
use crate::pty::path_norm::posix_drive_to_windows;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Convert a user-supplied path to a canonical absolute form.
/// On Windows, rewrites `/c/Users/...` → `C:\Users\...` first. Falls back to
/// the normalized (but possibly non-canonical) string if the path does not
/// exist yet — that lets the frontend still show a helpful "not found"
/// message without stripping off what the user typed.
#[tauri::command]
pub fn normalize_path(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    let input = posix_drive_to_windows(trimmed);
    match fs::canonicalize(PathBuf::from(&input)) {
        Ok(p) => {
            let s = p.to_string_lossy().to_string();
            // Windows canonicalize produces `\\?\C:\...`; strip for display.
            Ok(s.strip_prefix(r"\\?\")
                .map(|s| s.to_string())
                .unwrap_or(s))
        }
        Err(_) => Ok(input),
    }
}

/// List immediate children of `path`. Directories first, then files, each
/// sub-group sorted case-insensitively by name. Returns entries.len() capped
/// to 5000 — the caller gets a truncated list rather than an UI freeze.
#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let pb = PathBuf::from(&path);
    if !pb.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let read = fs::read_dir(&pb).map_err(|e| format!("read_dir failed: {e}"))?;

    let mut entries: Vec<FileEntry> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(FileEntry {
            name,
            path: entry_path,
            is_dir,
        });
        if entries.len() >= 5000 {
            break;
        }
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
pub fn save_pinned_roots(
    app_handle: tauri::AppHandle,
    pinned_roots: Vec<PinnedRoot>,
) -> Result<(), String> {
    let mut data = storage::load(&app_handle).unwrap_or_default();
    data.pinned_roots = pinned_roots;
    storage::save(&app_handle, &data)
}

#[tauri::command]
pub fn watch_root(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let watcher = state
        .fs_watcher
        .get()
        .ok_or_else(|| "fs watcher not ready".to_string())?;
    watcher.watch(PathBuf::from(path))
}

#[tauri::command]
pub fn unwatch_root(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let watcher = state
        .fs_watcher
        .get()
        .ok_or_else(|| "fs watcher not ready".to_string())?;
    watcher.unwatch(&PathBuf::from(path))
}

/// Open the target in the OS file manager. Files are "revealed" (parent
/// opened with the file selected); directories are opened directly.
/// Cross-platform; mycmux ships on Windows so that path is the one
/// exercised in production.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    let is_dir = pb.is_dir();
    #[cfg(target_os = "windows")]
    {
        let arg = if is_dir {
            path.clone()
        } else {
            format!("/select,{}", path)
        };
        std::process::Command::new("explorer.exe")
            .arg(arg)
            .spawn()
            .map_err(|e| format!("failed to launch explorer.exe: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if !is_dir {
            cmd.arg("-R");
        }
        cmd.arg(&path)
            .spawn()
            .map_err(|e| format!("failed to launch open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if is_dir {
            path.clone()
        } else {
            pb.parent()
                .map(|x| x.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone())
        };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("failed to launch xdg-open: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}
