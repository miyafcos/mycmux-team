use std::path::PathBuf;

/// Open the target in the OS file manager. Files are revealed in their parent
/// folder; directories are opened directly.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(format!("path does not exist: {path}"));
    }
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

/// Open a file or directory with the OS default application.
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
