use serde::Serialize;
use std::{path::PathBuf, time::Duration};
use tokio::process::Command;
#[derive(Default, Serialize)]
pub struct Check {
    pub found: bool,
    pub detail: String,
}
#[derive(Default, Serialize)]
pub struct Prerequisites {
    pub claude: Check,
    pub python: Check,
}
fn claude_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        #[cfg(windows)]
        let names = ["claude.exe", "claude.cmd", "claude.bat", "claude"];
        #[cfg(not(windows))]
        let names = ["claude"];
        for name in names {
            let candidate = dir.join(name);
            if !candidate.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if candidate.metadata().ok()?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Some(candidate);
        }
    }
    None
}
fn supported(version: &str) -> bool {
    let Some(number) = version.trim().strip_prefix("Python ") else {
        return false;
    };
    let mut parts = number.split('.');
    match (
        parts.next().and_then(|v| v.parse::<u32>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
    ) {
        (Some(major), Some(minor)) => major > 3 || (major == 3 && minor >= 10),
        _ => false,
    }
}
async fn python_check() -> Check {
    let mut failures = Vec::new();
    for name in ["python", "python3"] {
        let mut command = Command::new(name);
        command.arg("--version").kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        match tokio::time::timeout(Duration::from_secs(5), command.output()).await {
            Ok(Ok(output)) => {
                let detail = format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                )
                .trim()
                .to_string();
                if output.status.success() && supported(&detail) {
                    return Check {
                        found: true,
                        detail,
                    };
                }
                failures.push(format!("{name}: {detail}"));
            }
            Ok(Err(error)) => failures.push(format!("{name}: {error}")),
            Err(_) => failures.push(format!("{name}: timeout (5s)")),
        }
    }
    Check {
        found: false,
        detail: failures.join("; "),
    }
}
pub async fn check() -> Prerequisites {
    let claude = match claude_on_path() {
        Some(path) => Check {
            found: true,
            detail: path.to_string_lossy().into_owned(),
        },
        None => Check {
            found: false,
            detail: "Claude Code was not found on PATH".into(),
        },
    };
    Prerequisites {
        claude,
        python: python_check().await,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn python_version_floor() {
        for text in ["Python 3.10.0", "Python 3.14.1\n", "Python 4.0.0"] {
            assert!(supported(text));
        }
        for text in ["Python 3.9.9", "Python 2.7.18", "", "3.12", "Python broken"] {
            assert!(!supported(text));
        }
    }
}
