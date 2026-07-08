use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::commands::artifact::artifact_path_from_uri;
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

const DEFAULT_WALK_EXCLUDES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    ".cache",
];

fn modified_at_unix_secs(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

fn is_hidden_path(path: &Path, name: &str, include_hidden: bool) -> bool {
    if include_hidden {
        return false;
    }

    if name.starts_with('.') {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Ok(metadata) = fs::metadata(path) {
            return metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }

    false
}

fn should_skip_walk_entry(
    entry: &ignore::DirEntry,
    excludes: &HashSet<String>,
    include_hidden: bool,
) -> bool {
    if entry.depth() == 0 {
        return false;
    }

    let name = entry.file_name().to_string_lossy();
    excludes.contains(&name.to_ascii_lowercase())
        || is_hidden_path(entry.path(), name.as_ref(), include_hidden)
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
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
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
#[tauri::command(async)]
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
            Ok(s.strip_prefix(r"\\?\").map(|s| s.to_string()).unwrap_or(s))
        }
        Err(_) => Ok(input),
    }
}

/// List immediate children of `path`. Directories first, then files, each
/// sub-group sorted case-insensitively by name. Returns entries.len() capped
/// to 5000 — the caller gets a truncated list rather than an UI freeze.
#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn walk_tree(
    root: String,
    excludes: Vec<String>,
    max_depth: Option<usize>,
    limit: Option<usize>,
    include_hidden: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let max_depth = max_depth.unwrap_or(10);
    let limit = limit.unwrap_or(50_000);
    let include_hidden = include_hidden.unwrap_or(false);
    if limit == 0 {
        return Ok(Vec::new());
    }

    let exclude_names: HashSet<String> = excludes
        .into_iter()
        .chain(DEFAULT_WALK_EXCLUDES.iter().map(|name| (*name).to_string()))
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect();

    let mut builder = WalkBuilder::new(&root_path);
    let filter_excludes = exclude_names.clone();
    builder
        .hidden(false)
        .follow_links(false)
        .max_depth(Some(max_depth))
        .filter_entry(move |entry| {
            !should_skip_walk_entry(entry, &filter_excludes, include_hidden)
        });
    let walker = builder.build();

    let mut entries = Vec::new();
    for result in walker {
        let Ok(dir_entry) = result else {
            continue;
        };
        if dir_entry.depth() == 0 || dir_entry.depth() > max_depth {
            continue;
        }

        let path = dir_entry.path();
        let name = dir_entry.file_name().to_string_lossy().to_string();
        if exclude_names.contains(&name.to_ascii_lowercase())
            || is_hidden_path(path, &name, include_hidden)
        {
            continue;
        }

        let is_dir = dir_entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or_else(|| path.is_dir());

        entries.push(FileEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            modified: modified_at_unix_secs(path),
        });

        if entries.len() >= limit {
            break;
        }
    }

    Ok(entries)
}

#[tauri::command(async)]
pub fn save_pinned_roots(
    app_handle: tauri::AppHandle,
    pinned_roots: Vec<PinnedRoot>,
) -> Result<(), String> {
    storage::update(&app_handle, |data| {
        data.schema_version = 1;
        data.pinned_roots = pinned_roots;
    })
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
#[tauri::command(async)]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let canonical = pb.canonicalize().unwrap_or(pb);
    let is_dir = canonical.is_dir();
    #[cfg(target_os = "windows")]
    {
        let args = windows_explorer_reveal_args(&canonical, is_dir);
        std::process::Command::new("explorer.exe")
            .args(args)
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
        cmd.arg(&canonical)
            .spawn()
            .map_err(|e| format!("failed to launch open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if is_dir {
            canonical.to_string_lossy().to_string()
        } else {
            canonical
                .parent()
                .map(|x| x.to_string_lossy().to_string())
                .unwrap_or_else(|| canonical.to_string_lossy().to_string())
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
/// Windows delegates to Explorer so local files use the registered default app.
#[tauri::command(async)]
pub fn open_with_default(path: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let canonical = pb.canonicalize().unwrap_or(pb);
    #[cfg(target_os = "windows")]
    {
        let target = windows_display_path(&canonical);
        std::process::Command::new("explorer.exe")
            .arg(target)
            .spawn()
            .map_err(|e| format!("failed to launch default app: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("failed to launch open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("failed to launch xdg-open: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

#[tauri::command(async)]
pub async fn reveal_path_in_explorer(uri: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = artifact_path_from_uri(&uri)?;
        reveal_path_in_explorer_path(&path)
    })
    .await
    .map_err(|error| format!("join reveal_path_in_explorer: {error}"))?
}

fn reveal_path_in_explorer_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.to_string_lossy()));
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .args(windows_explorer_artifact_args(&canonical, canonical.is_dir()))
            .spawn()
            .map_err(|e| format!("failed to launch explorer.exe: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if canonical.is_file() {
            cmd.arg("-R").arg(&canonical);
        } else {
            cmd.arg(&canonical);
        }
        cmd.spawn()
            .map_err(|e| format!("failed to launch open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if canonical.is_dir() {
            canonical.to_path_buf()
        } else {
            canonical
                .parent()
                .map(|x| x.to_path_buf())
                .unwrap_or_else(|| canonical.to_path_buf())
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

#[cfg(target_os = "windows")]
fn windows_display_path(path: &std::path::Path) -> String {
    let value = path.to_string_lossy();
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
}

#[cfg(target_os = "windows")]
fn windows_explorer_reveal_args(path: &std::path::Path, is_dir: bool) -> Vec<String> {
    let target = windows_display_path(path);
    if is_dir {
        vec![target]
    } else {
        vec!["/select,".to_string(), target]
    }
}

#[cfg(target_os = "windows")]
fn windows_explorer_select_arg(path: &std::path::Path) -> String {
    format!("/select,{}", windows_display_path(path))
}

#[cfg(target_os = "windows")]
fn windows_explorer_artifact_args(path: &std::path::Path, is_dir: bool) -> Vec<String> {
    if is_dir {
        vec![windows_display_path(path)]
    } else {
        vec![windows_explorer_select_arg(path)]
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn explorer_reveal_file_keeps_select_switch_separate_from_path() {
        let args = windows_explorer_reveal_args(
            std::path::Path::new(r"C:\Users\miyaz\Desktop\sample doc.html"),
            false,
        );
        assert_eq!(
            args,
            vec![
                "/select,".to_string(),
                r"C:\Users\miyaz\Desktop\sample doc.html".to_string()
            ]
        );
    }

    #[test]
    fn explorer_reveal_directory_opens_directory_directly() {
        let args =
            windows_explorer_reveal_args(std::path::Path::new(r"C:\Users\miyaz\Desktop"), true);
        assert_eq!(args, vec![r"C:\Users\miyaz\Desktop".to_string()]);
    }

    #[test]
    fn explorer_select_arg_keeps_switch_and_path_in_one_argument() {
        let arg = windows_explorer_select_arg(std::path::Path::new(
            r"C:\Users\miyaz\Desktop\sample doc.pdf",
        ));
        assert_eq!(arg, r"/select,C:\Users\miyaz\Desktop\sample doc.pdf");
    }

    #[test]
    fn artifact_explorer_args_open_directory_without_select() {
        let args = windows_explorer_artifact_args(
            std::path::Path::new(r"C:\Users\miyaz\Desktop\sample folder"),
            true,
        );
        assert_eq!(
            args,
            vec![r"C:\Users\miyaz\Desktop\sample folder".to_string()]
        );
    }

    #[test]
    fn artifact_explorer_args_select_file_with_existing_select_form() {
        let args = windows_explorer_artifact_args(
            std::path::Path::new(r"C:\Users\miyaz\Desktop\sample doc.pdf"),
            false,
        );
        assert_eq!(
            args,
            vec![r"/select,C:\Users\miyaz\Desktop\sample doc.pdf".to_string()]
        );
    }
}

/// Create an empty file atomically via O_CREAT|O_EXCL (create_new). Returns
/// the absolute path so the frontend can select it after refresh.
#[tauri::command(async)]
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
#[tauri::command(async)]
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
