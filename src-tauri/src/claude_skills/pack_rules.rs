// Shared build/runtime rules from scripts/sync_claude_skills.py.
pub fn excluded_part(part: &str) -> bool {
    #[cfg(windows)]
    let part = part.to_lowercase();
    #[cfg(windows)]
    let part = part.as_str();
    matches!(
        part,
        "__pycache__" | ".pytest_cache" | "_prev" | ".mycmux-pack.json"
    ) || part.ends_with(".pyc")
        || part.contains(".bak")
        || part.starts_with("_backup")
}
pub fn is_text(path: &std::path::Path) -> bool {
    path.extension().and_then(|v| v.to_str()).is_some_and(|v| {
        matches!(
            v.to_lowercase().as_str(),
            "py" | "md" | "json" | "txt" | "yaml" | "yml" | "sh" | "ps1" | "toml" | "cfg" | "ini"
        )
    })
}
