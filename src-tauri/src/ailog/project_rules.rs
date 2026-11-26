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
        Self {
            key: normalize_key(&label),
            label,
            rule,
        }
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
    if lower
        .windows(3)
        .any(|window| window == ["appdata", "local", "temp"])
        || lower
            .windows(2)
            .any(|window| window == ["appdata", "roaming"])
        || lower.iter().any(|part| part == ".git")
    {
        return true;
    }
    parts.last().is_some_and(|file| !file.contains('.'))
}

fn path_rule(path: &str, home: &[String]) -> Option<ProjectAttribution> {
    let parts = parts(path);
    let office = parts.iter().position(|part| part == "事務関係");
    if let Some(index) = office {
        let labels = &parts[index + 1..];
        if let Some(client) = labels.first() {
            let label = labels
                .get(1)
                .map_or_else(|| client.to_string(), |series| format!("{client}/{series}"));
            return Some(ProjectAttribution::new(label, "dropbox_office"));
        }
    }
    if let Some(index) = parts.iter().position(|part| part == "マイドライブ") {
        let labels = &parts[index + 1..];
        if let Some(client) = labels.first() {
            let label = labels
                .get(1)
                .map_or_else(|| client.to_string(), |series| format!("{client}/{series}"));
            return Some(ProjectAttribution::new(label, "my_drive"));
        }
    }
    if let Some(index) = parts.iter().position(|part| is_numbered_folder(part)) {
        if index > 0 {
            return Some(ProjectAttribution::new(
                &parts[index - 1],
                "numbered_folder",
            ));
        }
    }
    if let Some(index) = parts
        .iter()
        .position(|part| matches!(part.as_str(), ".claude" | ".codex" | ".mycmux"))
    {
        if index > 0 || parts.len() > 1 {
            return Some(ProjectAttribution::new("Claude環境", "claude_environment"));
        }
    }
    if has_home_prefix(&parts, home) {
        if let Some(repo) = parts.get(home.len()).filter(|repo| !repo.starts_with('.')) {
            return Some(ProjectAttribution::new(repo, "home_repository"));
        }
    }
    None
}

fn is_numbered_folder(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() && bytes[2] == b'_'
}

fn has_home_prefix(path: &[String], home: &[String]) -> bool {
    let windows_drive = home.first().is_some_and(|part| part.ends_with(':'));
    !home.is_empty()
        && path.len() >= home.len()
        && path.iter().zip(home).all(|(actual, expected)| {
            if windows_drive {
                actual.eq_ignore_ascii_case(expected)
            } else {
                actual == expected
            }
        })
}

fn absolute_touch(cwd: &str, touch: &str) -> String {
    let normalized = touch.replace('\\', "/");
    let is_absolute = normalized.starts_with('/') || normalized.get(1..2) == Some(":");
    if is_absolute {
        normalized
    } else {
        format!("{}/{}", cwd.trim_end_matches(['\\', '/']), normalized)
    }
}

pub fn derive_project(cwd: &str, touched_paths: &[&str]) -> ProjectAttribution {
    let home = dirs::home_dir().map_or_else(Vec::new, |home| parts(&home.to_string_lossy()));
    #[cfg(test)]
    let home = FIXTURE_HOME.lock().unwrap().as_ref()
        .filter(|(fixture_cwd, _)| *fixture_cwd == cwd)
        .map(|(_, fixture_home)| parts(fixture_home))
        .unwrap_or(home);
    derive_project_for_home(cwd, touched_paths, &home)
}

#[cfg(test)]
static FIXTURE_HOME: std::sync::Mutex<Option<(&str, &str)>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn with_fixture_home<R>(cwd: &'static str, home: &'static str, run: impl FnOnce() -> R) -> R {
    // The DB writer runs on a blocking thread. Scope the override to this
    // fixture's exact cwd so concurrent tests still use the normal home.
    struct RestoreHome;
    impl Drop for RestoreHome {
        fn drop(&mut self) {
            *FIXTURE_HOME.lock().unwrap() = None;
        }
    }
    assert!(FIXTURE_HOME.lock().unwrap().replace((cwd, home)).is_none());
    let _restore = RestoreHome;
    run()
}

fn derive_project_for_home(cwd: &str, touched_paths: &[&str], home: &[String]) -> ProjectAttribution {
    let cwd_parts = parts(cwd);
    if cwd_parts.len() != home.len() || !has_home_prefix(&cwd_parts, home) {
        if let Some(attribution) = path_rule(cwd, home) {
            return attribution;
        }
    }

    let mut votes: BTreeMap<String, (usize, ProjectAttribution)> = BTreeMap::new();
    for touch in touched_paths {
        let path = absolute_touch(cwd, touch);
        if is_attribution_noise(&path) {
            continue;
        }
        if let Some(attribution) = path_rule(&path, home) {
            let entry = votes
                .entry(attribution.key.clone())
                .or_insert((0, attribution));
            entry.0 += 1;
        }
    }
    votes
        .into_values()
        .max_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| right.1.key.cmp(&left.1.key))
        })
        .map(|(_, attribution)| attribution)
        .unwrap_or_else(|| ProjectAttribution::new("その他", "fallback"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_all_path_rules_and_normalizes_key() {
        assert_eq!(
            derive_project(r"C:\Users\example\Dropbox\事務関係\北斗学院\ひかりスタ\数学", &[]).label,
            "北斗学院/ひかりスタ"
        );
        assert_eq!(
            derive_project(r"C:\マイドライブ\サンプル出版\数学", &[]).label,
            "サンプル出版/数学"
        );
        assert_eq!(
            derive_project(r"C:\work\案件A\19_スライド制作前準備", &[]).label,
            "案件A"
        );
        assert_eq!(
            derive_project_for_home(
                r"C:\Users\example\cmux-for-linux-dev-master",
                &[],
                &parts(r"C:\Users\Example"),
            ).label,
            "cmux-for-linux-dev-master"
        );
        assert_eq!(
            derive_project(r"C:\Users\example\.claude\skills\x", &[]).label,
            "Claude環境"
        );
        assert_eq!(normalize_key("北斗学院\\ひかりスタ"), "北斗学院/ひかりスタ");
    }


    #[test]
    fn lane_d_home_repository_attribution_preserves_the_windows_shape() {
        for (home, cwd, file) in [
            (r"C:\Users\Example", r"c:\users\EXAMPLE\ProjectX", r"c:\users\EXAMPLE\ProjectX\file.rs"),
            ("/Users/sample-owner", "/Users/sample-owner/ProjectX", "/Users/sample-owner/ProjectX/file.rs"),
        ] {
            let home_parts = parts(home);
            let from_cwd = derive_project_for_home(cwd, &[], &home_parts);
            let from_file = derive_project_for_home(home, &[file], &home_parts);
            assert_eq!(from_cwd, ProjectAttribution::new("ProjectX", "home_repository"));
            assert_eq!((from_file.key, from_file.label), (from_cwd.key, from_cwd.label));
        }
    }

    #[test]
    fn home_and_system_paths_vote_from_non_noise_touches() {
        let touches = [
            r"C:\dropbox\事務関係\北斗学院\ひかりスタ\a.md",
            r"C:\dropbox\事務関係\北斗学院\ひかりスタ\b.md",
            r"C:\Users\example\AppData\Local\Temp\scratch.tmp",
        ];
        assert_eq!(
            derive_project_for_home(r"C:\Users\example", &touches, &parts(r"C:\Users\example")).label,
            "北斗学院/ひかりスタ"
        );
        assert_eq!(
            derive_project(r"C:\Windows\System32", &touches).label,
            "北斗学院/ひかりスタ"
        );
    }

    #[test]
    fn noise_is_excluded_and_empty_votes_fall_back() {
        assert!(is_attribution_noise(
            r"C:\Users\example\AppData\Roaming\x.txt"
        ));
        assert!(is_attribution_noise(r"C:\repo\.git\HEAD"));
        assert!(is_attribution_noise(r"C:\tmp\scratch"));
        assert_eq!(
            derive_project(r"C:\Windows\System32", &[r"C:\tmp\scratch"]).label,
            "その他"
        );
    }
}
