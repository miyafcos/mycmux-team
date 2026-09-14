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
/// A skill keeps personal or machine-bound files out of the portable pack by
/// listing them in `.packignore` at its root: one rule per line, `#` comments,
/// a rule ending in `/` covers that directory, any other rule names one file.
/// Mirrors `packignore_rules` / `packignored` in scripts/sync_claude_skills.py.
pub const PACKIGNORE: &str = ".packignore";

pub fn packignore_rules(text: &str) -> Vec<String> {
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(|line| line.trim().replace('\\', "/"))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

pub fn packignored(rel: &str, rules: &[String]) -> bool {
    rules.iter().any(|rule| match rule.strip_suffix('/') {
        Some(dir) => rel == dir || rel.starts_with(rule.as_str()),
        None => rel == rule,
    })
}

pub fn is_text(path: &std::path::Path) -> bool {
    // `.packignore` has no extension but is a text rule file (mirrors
    // sync_claude_skills.is_text), so a CRLF checkout hashes the same.
    if path.file_name().and_then(|v| v.to_str()) == Some(PACKIGNORE) {
        return true;
    }
    path.extension().and_then(|v| v.to_str()).is_some_and(|v| {
        matches!(
            v.to_lowercase().as_str(),
            "py" | "md" | "json" | "txt" | "yaml" | "yml" | "sh" | "ps1" | "toml" | "cfg" | "ini"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packignore_rules_cover_a_directory_or_name_one_file() {
        let rules = packignore_rules(
            "\u{feff}# personal setup\nmcp/\r\nreferences\\local-mcp-sandbox.md\n\n",
        );
        assert_eq!(
            rules,
            vec!["mcp/".to_string(), "references/local-mcp-sandbox.md".to_string()]
        );
        assert!(packignored("mcp", &rules));
        assert!(packignored("mcp/stack.py", &rules));
        assert!(packignored("references/local-mcp-sandbox.md", &rules));
        assert!(!packignored("mcp2/x.py", &rules));
        assert!(!packignored("references/local-mcp-sandbox.md.bak", &rules));
        assert!(!packignored("SKILL.md", &rules));
        assert!(packignore_rules("").is_empty());
        assert!(!packignored("anything", &[]));
    }

    #[test]
    fn the_rule_file_itself_is_text() {
        assert!(is_text(std::path::Path::new("oracmux/.packignore")));
        assert!(is_text(std::path::Path::new("SKILL.md")));
        assert!(!is_text(std::path::Path::new("icon.png")));
        assert!(!is_text(std::path::Path::new("LICENSE")));
    }
}
