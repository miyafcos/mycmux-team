//! Deterministic project attribution from a session cwd and touched files.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectAttribution {
    pub key: String,
    pub label: String,
    pub rule: &'static str,
}

impl ProjectAttribution {
    fn new(label: impl Into<String>, rule: &'static str) -> Self {
        let label = label.into();
        Self { key: normalize_key(&label), label, rule }
    }
}

pub fn normalize_key(label: &str) -> String {
    label
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
        .to_lowercase()
}

fn parts(path: &str) -> Vec<String> {
    path.replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn is_attribution_noise(path: &str) -> bool {
    let parts = parts(path);
    let lower: Vec<String> = parts.iter().map(|part| part.to_lowercase()).collect();
    if lower.windows(3).any(|window| window == ["appdata", "local", "temp"])
        || lower.windows(2).any(|window| window == ["appdata", "roaming"])
        || lower.iter().any(|part| part == ".git")
    {
        return true;
    }
    parts.last().is_some_and(|file| !file.contains('.'))
}

fn path_rule(path: &str, allow_home_repo: bool) -> Option<ProjectAttribution> {
    let parts = parts(path);
    let office = parts.iter().position(|part| part == "事務関係");
    if let Some(index) = office {
        let labels = &parts[index + 1..];
        if let Some(client) = labels.first() {
            let label = labels.get(1).map_or_else(|| client.to_string(), |series| format!("{client}/{series}"));
            return Some(ProjectAttribution::new(label, "dropbox_office"));
        }
    }
    if let Some(index) = parts.iter().position(|part| part == "マイドライブ") {
        let labels = &parts[index + 1..];
        if let Some(client) = labels.first() {
            let label = labels.get(1).map_or_else(|| client.to_string(), |series| format!("{client}/{series}"));
            return Some(ProjectAttribution::new(label, "my_drive"));
        }
    }
    if let Some(index) = parts.iter().position(|part| is_numbered_folder(part)) {
        if index > 0 {
            return Some(ProjectAttribution::new(&parts[index - 1], "numbered_folder"));
        }
    }
    if let Some(index) = parts.iter().position(|part| matches!(part.as_str(), ".claude" | ".codex" | ".mycmux")) {
        if index > 0 || parts.len() > 1 {
            return Some(ProjectAttribution::new("Claude環境", "claude_environment"));
        }
    }
    if allow_home_repo && parts.len() >= 4 && parts[0].eq_ignore_ascii_case("C:") && parts[1].eq_ignore_ascii_case("Users") && parts[2].eq_ignore_ascii_case("miyaz") {
        let repo = &parts[3];
        if !repo.starts_with('.') {
            return Some(ProjectAttribution::new(repo, "home_repository"));
        }
    }
    None
}

fn is_numbered_folder(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() && bytes[2] == b'_'
}

fn is_home_root(cwd: &str) -> bool {
    let normalized = cwd.replace('\\', "/").trim_end_matches('/').to_lowercase();
    normalized == "c:/users/miyaz"
}

fn absolute_touch(cwd: &str, touch: &str) -> String {
    let normalized = touch.replace('\\', "/");
    let is_absolute = normalized.starts_with('/') || normalized.get(1..2) == Some(":");
    if is_absolute { normalized } else { format!("{}/{}", cwd.trim_end_matches(['\\', '/']), normalized) }
}

pub fn derive_project(cwd: &str, touched_paths: &[&str]) -> ProjectAttribution {
    if !is_home_root(cwd) {
        if let Some(attribution) = path_rule(cwd, true) {
            return attribution;
        }
    }

    let mut votes: BTreeMap<String, (usize, ProjectAttribution)> = BTreeMap::new();
    for touch in touched_paths {
        let path = absolute_touch(cwd, touch);
        if is_attribution_noise(&path) { continue; }
        if let Some(attribution) = path_rule(&path, true) {
            let entry = votes.entry(attribution.key.clone()).or_insert((0, attribution));
            entry.0 += 1;
        }
    }
    votes.into_values()
        .max_by(|left, right| left.0.cmp(&right.0).then_with(|| right.1.key.cmp(&left.1.key)))
        .map(|(_, attribution)| attribution)
        .unwrap_or_else(|| ProjectAttribution::new("その他", "fallback"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_all_path_rules_and_normalizes_key() {
        assert_eq!(derive_project(r"C:\Users\miyaz\Dropbox\事務関係\駿台\モモスタ\数学", &[]).label, "駿台/モモスタ");
        assert_eq!(derive_project(r"C:\マイドライブ\東京書籍\数学", &[]).label, "東京書籍/数学");
        assert_eq!(derive_project(r"C:\work\案件A\19_スライド制作前準備", &[]).label, "案件A");
        assert_eq!(derive_project(r"C:\Users\miyaz\cmux-for-linux-dev-master", &[]).label, "cmux-for-linux-dev-master");
        assert_eq!(derive_project(r"C:\Users\miyaz\.claude\skills\x", &[]).label, "Claude環境");
        assert_eq!(normalize_key("駿台\\モモスタ"), "駿台/モモスタ");
    }

    #[test]
    fn home_and_system_paths_vote_from_non_noise_touches() {
        let touches = [r"C:\dropbox\事務関係\駿台\モモスタ\a.md", r"C:\dropbox\事務関係\駿台\モモスタ\b.md", r"C:\Users\miyaz\AppData\Local\Temp\scratch.tmp"];
        assert_eq!(derive_project(r"C:\Users\miyaz", &touches).label, "駿台/モモスタ");
        assert_eq!(derive_project(r"C:\Windows\System32", &touches).label, "駿台/モモスタ");
    }

    #[test]
    fn noise_is_excluded_and_empty_votes_fall_back() {
        assert!(is_attribution_noise(r"C:\Users\miyaz\AppData\Roaming\x.txt"));
        assert!(is_attribution_noise(r"C:\repo\.git\HEAD"));
        assert!(is_attribution_noise(r"C:\tmp\scratch"));
        assert_eq!(derive_project(r"C:\Windows\System32", &[r"C:\tmp\scratch"]).label, "その他");
    }
}
