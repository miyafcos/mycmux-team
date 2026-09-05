#[derive(serde::Serialize)]
pub struct DefaultShellInfo {
    pub command: String,
    pub args: Vec<String>,
}

fn is_bash_like_shell_path(path: &str) -> bool {
    // Split on both separators rather than through `Path`: the value comes from
    // SHELL and can be a Windows path, which a non-Windows `Path` treats as one
    // long file name.
    let leaf = path
        .rsplit(['/', '\\'])
        .next()
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

/// The PATH a pane should run with, or `None` when the process already has a
/// usable one.
///
/// A macOS app launched from Finder or the Dock inherits launchd's PATH —
/// `/usr/bin:/bin:/usr/sbin:/sbin` — instead of the one the user's shell
/// builds. Every agent lives outside those four directories (Homebrew,
/// `~/.local/bin`, `~/.cargo/bin`), so the launcher menu drew fine, a pick
/// exited 127, and the pane fell through to a bare shell that had just fixed
/// its own PATH from `.zshrc` — which is exactly why it looked like the
/// launcher did nothing. Windows never saw this: its PATH is inherited by
/// every process regardless of how the app started.
///
/// So ask the login shell once for the PATH it would build. It runs
/// interactively (`-i`) because a zsh user's PATH usually lives in `.zshrc`,
/// which a login-only shell never reads.
#[cfg(target_os = "macos")]
pub(crate) fn login_shell_path() -> Option<&'static str> {
    static RESOLVED: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    RESOLVED
        .get_or_init(resolve_login_shell_path)
        .as_deref()
}

#[cfg(target_os = "macos")]
fn resolve_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if !std::path::Path::new(&shell).exists() {
        return None;
    }
    // On its own thread with a deadline: a login shell that blocks on some
    // interactive rc line must not hold up the first pane forever.
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let output = std::process::Command::new(&shell)
            .args(["-l", "-i", "-c", "printf %s \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .output();
        let _ = sender.send(output);
    });
    let output = receiver
        .recv_timeout(std::time::Duration::from_secs(8))
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let reported = String::from_utf8(output.stdout).ok()?;
    let path = usable_login_path(&reported, &std::env::var("PATH").unwrap_or_default())?;
    crate::diag::warn("shell", &format!("resolved login PATH for panes: {path}"));
    Some(path)
}

/// Whether a shell's reported PATH is worth handing to a pane.
///
/// Split out from the shell call so the rules are testable: reject what is not
/// a PATH at all, and reject one that matches what the process already has,
/// since overriding with an identical value only hides where a pane's PATH
/// came from.
#[cfg(any(target_os = "macos", test))]
fn usable_login_path(reported: &str, current: &str) -> Option<String> {
    let path = reported.trim();
    if path.is_empty() || !path.contains('/') {
        return None;
    }
    if path == current {
        return None;
    }
    Some(path.to_string())
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
    fn login_path_is_taken_when_it_differs_from_the_process_path() {
        let launchd = "/usr/bin:/bin:/usr/sbin:/sbin";
        let from_shell = "/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin\n";

        assert_eq!(
            usable_login_path(from_shell, launchd).as_deref(),
            Some("/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"),
        );
    }

    #[test]
    fn login_path_is_ignored_when_it_adds_nothing_or_is_not_a_path() {
        let launchd = "/usr/bin:/bin:/usr/sbin:/sbin";

        assert_eq!(usable_login_path(launchd, launchd), None);
        assert_eq!(usable_login_path("  ", launchd), None);
        // A shell that printed an error or a bare word instead of a PATH.
        assert_eq!(usable_login_path("command not found", launchd), None);
    }

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
