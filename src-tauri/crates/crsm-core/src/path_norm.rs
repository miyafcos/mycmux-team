use std::path::{Path, PathBuf};

pub fn home_dir() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CRSM_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    dirs::home_dir()
}

pub fn normalize_agent_cwd(cwd: &str) -> String {
    let normalized = if cwd.starts_with('/') && cwd.len() > 2 && cwd.as_bytes()[2] == b'/' {
        format!(
            "{}:{}",
            cwd[1..2].to_uppercase(),
            cwd[2..].replace('/', "\\")
        )
    } else {
        cwd.replace('/', "\\")
    };
    let trimmed = normalized.trim_end_matches(['\\', '/']);
    let normalized_path = Path::new(trimmed)
        .canonicalize()
        .unwrap_or_else(|_| Path::new(trimmed).to_path_buf())
        .to_string_lossy()
        .to_string();
    normalized_path
        .strip_prefix(r"\\?\")
        .unwrap_or(&normalized_path)
        .to_string()
}

pub fn normalize_cwd_key(cwd: &str) -> String {
    normalize_agent_cwd(cwd).to_ascii_lowercase()
}

pub fn claude_project_key(cwd: &str) -> String {
    normalize_agent_cwd(cwd).replace([':', '\\', '/'], "-")
}

pub fn claude_session_path(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(claude_project_key(cwd))
        .join(format!("{session_id}.jsonl"))
}

pub fn crsm_dir(home: &Path) -> PathBuf {
    home.join(".crsm")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_git_bash_drive_paths() {
        assert_eq!(
            normalize_agent_cwd("/c/Users/miyaz/repo"),
            "C:\\Users\\miyaz\\repo"
        );
    }
}
