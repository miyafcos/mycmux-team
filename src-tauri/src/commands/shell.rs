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

#[tauri::command(async)]
pub fn get_default_shell() -> DefaultShellInfo {
    #[cfg(target_os = "windows")]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).exists() && is_bash_like_shell_path(&shell) {
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
}
