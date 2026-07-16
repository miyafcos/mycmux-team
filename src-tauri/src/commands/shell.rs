#[derive(serde::Serialize)]
pub struct DefaultShellInfo {
    pub command: String,
    pub args: Vec<String>,
}

fn is_bash_like_shell_path(path: &str) -> bool {
    let leaf = std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_ascii_lowercase();
    matches!(leaf.as_str(), "bash" | "bash.exe" | "sh" | "sh.exe")
}

/// Git's `usr\bin\bash.exe` started directly skips the `bin\bash.exe` wrapper
/// that prepends `mingw64\bin` and `usr\bin` to PATH. Without that prepend,
/// `#!/usr/bin/env bash` shebangs inside the pane resolve through the plain
/// Windows PATH and can land on the WindowsApps WSL stub ("no distributions
/// installed"). SHELL can arrive as the direct path when mycmux is restarted
/// from another tool's environment (2026-07-12: Codex-driven deploy restart
/// exported SHELL=C:\Program Files\Git\usr\bin\bash.exe), so rewrite it to
/// the sibling wrapper when one exists.
#[cfg(any(target_os = "windows", test))]
fn prefer_wrapper_bash(shell: &str) -> String {
    let path = std::path::Path::new(shell);
    let in_usr_bin = path
        .parent()
        .and_then(|bin| {
            let bin_name = bin.file_name()?;
            let usr_name = bin.parent()?.file_name()?;
            Some(bin_name.eq_ignore_ascii_case("bin") && usr_name.eq_ignore_ascii_case("usr"))
        })
        .unwrap_or(false);
    if !in_usr_bin {
        return shell.to_string();
    }
    let wrapper = match (
        path.file_name(),
        path.parent().and_then(|bin| bin.parent()).and_then(|usr| usr.parent()),
    ) {
        (Some(leaf), Some(root)) => root.join("bin").join(leaf),
        _ => return shell.to_string(),
    };
    if wrapper.exists() {
        wrapper.to_string_lossy().into_owned()
    } else {
        shell.to_string()
    }
}

#[tauri::command(async)]
pub fn get_default_shell() -> DefaultShellInfo {
    #[cfg(target_os = "windows")]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).exists() && is_bash_like_shell_path(&shell) {
                let shell = prefer_wrapper_bash(&shell);
                let args = if shell.to_ascii_lowercase().ends_with("bash.exe") {
                    vec!["-i".to_string()]
                } else {
                    vec![]
                };
                return DefaultShellInfo {
                    command: shell,
                    args,
                };
            }
        }
        // Git Bash
        let git_bash = "C:\\Program Files\\Git\\bin\\bash.exe";
        if std::path::Path::new(git_bash).exists() {
            return DefaultShellInfo {
                command: git_bash.to_string(),
                args: vec!["-i".to_string()],
            };
        }
        // PowerShell
        let pwsh = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        if std::path::Path::new(pwsh).exists() {
            return DefaultShellInfo {
                command: pwsh.to_string(),
                args: vec![],
            };
        }
        // cmd.exe fallback
        DefaultShellInfo {
            command: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
            args: vec![],
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).exists() {
                return DefaultShellInfo {
                    command: shell,
                    args: vec![],
                };
            }
        }

        DefaultShellInfo {
            command: "/bin/bash".to_string(),
            args: vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_detection_accepts_only_bash_like_shell_env() {
        assert!(is_bash_like_shell_path(
            r"C:\Program Files\Git\bin\bash.exe"
        ));
        assert!(is_bash_like_shell_path("/bin/sh"));
        assert!(!is_bash_like_shell_path(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        ));
    }

    #[test]
    fn prefer_wrapper_bash_rewrites_git_usr_bin_to_wrapper() {
        let tmp = std::env::temp_dir().join(format!("mycmux-shell-test-{}", std::process::id()));
        let usr_bin = tmp.join("usr").join("bin");
        let bin = tmp.join("bin");
        std::fs::create_dir_all(&usr_bin).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let direct = usr_bin.join("bash.exe");
        let wrapper = bin.join("bash.exe");
        std::fs::write(&direct, b"").unwrap();
        std::fs::write(&wrapper, b"").unwrap();

        let rewritten = prefer_wrapper_bash(direct.to_str().unwrap());
        assert_eq!(rewritten, wrapper.to_string_lossy());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn prefer_wrapper_bash_leaves_non_usr_bin_paths_alone() {
        assert_eq!(
            prefer_wrapper_bash(r"C:\Program Files\Git\bin\bash.exe"),
            r"C:\Program Files\Git\bin\bash.exe"
        );
        assert_eq!(prefer_wrapper_bash("/bin/sh"), "/bin/sh");
    }
}
