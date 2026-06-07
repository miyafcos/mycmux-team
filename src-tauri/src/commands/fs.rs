use std::path::PathBuf;

/// Open the target in the OS file manager. Files are revealed in their parent
/// folder; directories are opened directly.
#[tauri::command]
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

/// Open a file or directory with the OS default application.
#[tauri::command]
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
}
