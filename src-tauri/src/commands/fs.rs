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
    pub modified: Option<u64>,
}

/// Validate a user-supplied leaf name for create_file / create_folder.
/// Defense in depth - the UI also caps input to bare filenames, but the
/// command layer never trusts the frontend.
fn validate_leaf_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name is empty".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("name must not contain path separators".into());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("invalid name".into());
    }
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
        "LPT9",
    ];
    let upper = trimmed.to_ascii_uppercase();
    for reserved in RESERVED {
        if upper == *reserved || upper.starts_with(&format!("{reserved}.")) {
            return Err("reserved name on Windows".into());
        }
    }
    Ok(trimmed)
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
        // NOTE: entry.metadata() follows symlinks. mycmux's existing
        // list_directory keeps that behavior in Iteration 3.
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        entries.push(FileEntry {
            name,
            path: entry_path,
            is_dir,
            modified,
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

/// Open a file with the OS default application. For directories this is a
/// no-op in spirit (the UI hides this menu item for dirs). Cross-platform;
/// Windows uses rundll32 so no console flash.
#[tauri::command]
pub fn open_with_default(path: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("failed to launch default app: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("failed to launch open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("failed to launch xdg-open: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

/// Create an empty file atomically via O_CREAT|O_EXCL (create_new). Returns
/// the absolute path so the frontend can select it after refresh.
#[tauri::command]
pub fn create_file(parent: String, name: String) -> Result<String, String> {
    let parent_pb = PathBuf::from(&parent);
    if !parent_pb.is_dir() {
        return Err(format!("parent is not a directory: {parent}"));
    }
    let leaf = validate_leaf_name(&name)?;
    let target = parent_pb.join(leaf);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("create_file failed: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

/// Create a single directory (non-recursive). `name` must not contain
/// separators or be a reserved name.
#[tauri::command]
pub fn create_folder(parent: String, name: String) -> Result<String, String> {
    let parent_pb = PathBuf::from(&parent);
    if !parent_pb.is_dir() {
        return Err(format!("parent is not a directory: {parent}"));
    }
    let leaf = validate_leaf_name(&name)?;
    let target = parent_pb.join(leaf);
    if target.exists() {
        return Err(format!("already exists: {}", target.to_string_lossy()));
    }
    fs::create_dir(&target).map_err(|e| format!("create_dir failed: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}
