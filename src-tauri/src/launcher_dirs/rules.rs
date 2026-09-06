use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{model::LauncherDirsDoc, paths::{is_absolute_path, normalize_path}};

pub const DEFAULT_GIT_EXCLUDE_PREFIXES: [&str; 3] = ["_", ".", "~$"];
pub const DEFAULT_GIT_EXCLUDE_NAMES: [&str; 3] = ["AppData", "Dropbox", "OneDrive"];
pub const DEFAULT_GIT_EXCLUDE_SUBSTRINGS: [&str; 1] = ["backup"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Suggest,
    Auto,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Exclude {
    #[serde(default)]
    pub prefixes: Vec<String>,
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub substrings: Vec<String>,
}

impl Exclude {
    pub fn matches(&self, name: &str) -> bool {
        self.prefixes.iter().any(|prefix| name.starts_with(prefix))
            || self.names.iter().any(|value| value == name)
            || self.substrings.iter().any(|part| name.contains(part))
    }

    pub fn matches_git(&self, name: &str) -> bool {
        self.matches(name)
            || self
                .substrings
                .iter()
                .any(|part| name.to_lowercase().contains(&part.to_lowercase()))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepthOverride {
    pub prefix: String,
    pub depth: u32,
}

fn depth_default() -> u32 {
    2
}
fn max_depth_default() -> u32 {
    6
}
fn mentions_default() -> u32 {
    3
}
fn sessions_default() -> u32 {
    1
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RuleKind {
    #[serde(rename = "git-parents")]
    GitParents {
        parents: Vec<String>,
        #[serde(default)]
        exclude: Exclude,
    },
    #[serde(rename = "folder-root")]
    FolderRoot {
        root: String,
        #[serde(default = "depth_default")]
        depth: u32,
        #[serde(default)]
        depth_overrides: Vec<DepthOverride>,
        #[serde(default = "max_depth_default")]
        max_depth: u32,
        #[serde(default)]
        exclude: Exclude,
        #[serde(default)]
        top_level_exclude: Vec<String>,
    },
    #[serde(rename = "session-cwd")]
    SessionCwd {
        #[serde(default)]
        root: Option<String>,
        #[serde(default = "sessions_default")]
        min_sessions: u32,
    },
    #[serde(rename = "session-mentions")]
    SessionMentions {
        root: String,
        #[serde(default = "depth_default")]
        depth: u32,
        #[serde(default)]
        depth_overrides: Vec<DepthOverride>,
        #[serde(default = "mentions_default")]
        min_mentions: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub section: String,
    pub mode: Mode,
    pub enabled: bool,
    pub window_days: u32,
    pub max: u32,
    #[serde(flatten)]
    pub kind: RuleKind,
}

impl Rule {
    pub fn from_value(value: &Value) -> Option<Self> {
        Self::parse(value).ok()
    }

    pub fn parse(value: &Value) -> Result<Self, String> {
        let mut value = value.clone();
        let object = value.as_object_mut().ok_or("expected an object")?;
        let (days, max) = match object.get("type").and_then(Value::as_str) {
            Some("git-parents") => (30, 10),
            Some("folder-root") => (21, 20),
            Some("session-cwd") => (30, 20),
            Some("session-mentions") => (14, 20),
            _ => return Err("unknown rule type".into()),
        };
        object.entry("window_days").or_insert(json!(days));
        object.entry("max").or_insert(json!(max));
        let mut rule: Self = serde_json::from_value(value).map_err(|error| error.to_string())?;
        if rule.directories().iter().any(|path| path.contains(['\r', '\n'])) {
            return Err("path contains a line break".into());
        }
        if !matches!(rule.section.as_str(), "dev" | "anken") {
            return Err("unknown section".into());
        }
        if rule.window_days == 0 || rule.max == 0 {
            return Err("window_days and max must be positive integers".into());
        }
        match &mut rule.kind {
            RuleKind::GitParents { parents, .. } => {
                if parents.is_empty() || parents.iter().any(|path| path.trim().is_empty()) {
                    return Err("parents must contain at least one directory".into());
                }
                for path in parents {
                    *path = normalize_path(path);
                    if !is_absolute_path(path) {
                        return Err(format!("path must be absolute: {path}"));
                    }
                }
            }
            RuleKind::FolderRoot {
                root,
                depth,
                depth_overrides,
                max_depth,
                ..
            } => {
                normalize_root(root)?;
                validate_depth(*depth, depth_overrides)?;
                if *max_depth == 0 {
                    return Err("max_depth must be positive".into());
                }
            }
            RuleKind::SessionCwd { root, min_sessions } => {
                if let Some(root) = root {
                    normalize_root(root)?;
                }
                if *min_sessions == 0 {
                    return Err("min_sessions must be positive".into());
                }
            }
            RuleKind::SessionMentions {
                root,
                depth,
                depth_overrides,
                min_mentions,
            } => {
                normalize_root(root)?;
                validate_depth(*depth, depth_overrides)?;
                if *min_mentions == 0 {
                    return Err("min_mentions must be positive".into());
                }
            }
        }
        Ok(rule)
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("rule serialization")
    }

    pub fn directories(&self) -> Vec<&str> {
        match &self.kind {
            RuleKind::GitParents { parents, .. } => parents.iter().map(String::as_str).collect(),
            RuleKind::FolderRoot { root, .. } | RuleKind::SessionMentions { root, .. } => {
                vec![root]
            }
            RuleKind::SessionCwd { root, .. } => root.as_deref().into_iter().collect(),
        }
    }
}

fn normalize_root(root: &mut String) -> Result<(), String> {
    if root.trim().is_empty() {
        return Err("root is required".into());
    }
    *root = normalize_path(root);
    if !is_absolute_path(root) {
        return Err(format!("path must be absolute: {root}"));
    }
    Ok(())
}

fn validate_depth(depth: u32, overrides: &[DepthOverride]) -> Result<(), String> {
    if depth == 0
        || overrides
            .iter()
            .any(|item| item.depth == 0 || item.prefix.trim().is_empty())
    {
        return Err("depth and overrides must be positive and have a prefix".into());
    }
    Ok(())
}

pub fn representative_depth(first: &str, depth: u32, overrides: &[DepthOverride]) -> usize {
    overrides
        .iter()
        .find(|item| item.prefix == first)
        .map_or(depth, |item| item.depth) as usize
}

// Call only when creating a ledger, never on a successfully loaded JSON document.
pub fn seed_defaults(doc: &mut LauncherDirsDoc) {
    if !doc.rules.is_empty() {
        return;
    }
    for kind in ["git-parents", "session-cwd"] {
        let mut value = json!({
            "id": uuid::Uuid::new_v4().simple().to_string(), "section": "dev",
            "type": kind, "enabled": true, "mode": "suggest", "parents": [normalize_path("~")]
        });
        if kind == "git-parents" {
            value["exclude"] = json!({
                "prefixes": DEFAULT_GIT_EXCLUDE_PREFIXES,
                "names": DEFAULT_GIT_EXCLUDE_NAMES,
                "substrings": DEFAULT_GIT_EXCLUDE_SUBSTRINGS,
            });
        }
        doc.rules.push(Rule::from_value(&value).unwrap().to_value());
    }
}

impl LauncherDirsDoc {
    pub fn upsert_rule(&mut self, value: &Value) -> Result<(), String> {
        let mut rule = Rule::parse(value).map_err(|reason| format!("invalid rule: {reason}"))?;
        if rule.id.is_empty() {
            rule.id = uuid::Uuid::new_v4().simple().to_string();
        }
        for path in rule.directories() {
            if !std::path::Path::new(path).is_dir() {
                return Err(format!("not a directory: {path}"));
            }
        }
        if let Some(index) = self
            .rules
            .iter()
            .position(|value| value.get("id").and_then(Value::as_str) == Some(&rule.id))
        {
            let previous = Rule::from_value(&self.rules[index]);
            if previous.is_some_and(|old| old.mode == Mode::Auto && rule.mode == Mode::Suggest) {
                self.remove_rule_entries(&rule.id);
            }
            self.rules[index] = rule.to_value();
        } else {
            self.rules.push(rule.to_value());
        }
        super::scan::remove_orphans(self);
        Ok(())
    }

    fn remove_rule_entries(&mut self, id: &str) {
        self.entries.retain(|entry| {
            entry.source == super::model::Source::Manual || entry.rule_id.as_deref() != Some(id)
        });
    }

    pub fn delete_rule(&mut self, id: &str) {
        self.rules
            .retain(|value| value.get("id").and_then(Value::as_str) != Some(id));
        self.remove_rule_entries(id);
        super::scan::remove_orphans(self);
    }

    pub fn set_rule_enabled(&mut self, id: &str, enabled: bool) -> Result<(), String> {
        let value = self
            .rules
            .iter_mut()
            .find(|value| value.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("unknown rule")?;
        Rule::from_value(value).ok_or("invalid rule: unknown or malformed rule")?;
        value["enabled"] = json!(enabled);
        Ok(())
    }

    pub fn set_rule_mode(&mut self, id: &str, mode: &str) -> Result<(), String> {
        if !matches!(mode, "auto" | "suggest") {
            return Err("invalid rule: unknown mode".into());
        }
        let value = self
            .rules
            .iter_mut()
            .find(|value| value.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("unknown rule")?;
        let previous = Rule::from_value(value).ok_or("invalid rule: unknown or malformed rule")?;
        value["mode"] = json!(mode);
        if previous.mode == Mode::Auto && mode == "suggest" {
            self.remove_rule_entries(id);
        }
        Ok(())
    }

    pub fn register_candidate(&mut self, section_id: &str, path: &str) -> Result<(), String> {
        let key = super::paths::path_key(path);
        let label = self
            .scan_data()
            .and_then(|scan| {
                scan.candidates
                    .into_iter()
                    .find(|candidate| super::paths::path_key(&candidate.path) == key)
            })
            .ok_or("unknown candidate")?
            .label;
        self.add_entry(section_id, path, Some(&label))
    }
}

#[cfg(test)]
pub(crate) fn fixture(kind: &str) -> Rule {
    let (parent, root) = if cfg!(windows) {
        ("C:/repos", "C:/work")
    } else {
        ("/repos", "/work")
    };
    Rule::from_value(
        &json!({"id":"r1", "section":"dev", "type":kind, "mode":"suggest",
        "enabled":true, "parents":[parent], "root":root}),
    )
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_git_exclusions_without_changing_explicitly_empty_saved_rules() {
        let mut doc = LauncherDirsDoc::default();
        seed_defaults(&mut doc);
        let expected = json!({
            "prefixes": ["_", ".", "~$"],
            "names": ["AppData", "Dropbox", "OneDrive"],
            "substrings": ["backup"],
        });
        assert_eq!(doc.rules[0]["type"], "git-parents");
        assert_eq!(doc.rules[0]["exclude"], expected);
        let root = tempfile::tempdir().unwrap();
        let mut rule = doc.rules[0].clone();
        rule["parents"] = json!([root.path().to_string_lossy()]);
        rule["exclude"] = json!({"prefixes": [], "names": [], "substrings": []});
        doc.upsert_rule(&rule).unwrap();
        seed_defaults(&mut doc);
        assert_eq!(doc.rules[0]["exclude"], rule["exclude"]);
        let RuleKind::GitParents { exclude, .. } = Rule::parse(&doc.rules[0]).unwrap().kind else {
            panic!("wrong rule kind");
        };
        assert_eq!(exclude, Exclude::default());
        rule.as_object_mut().unwrap().remove("exclude");
        let RuleKind::GitParents { exclude, .. } = Rule::parse(&rule).unwrap().kind else {
            panic!("wrong rule kind");
        };
        assert_eq!(exclude, Exclude::default());
    }

    #[test]
    fn rejects_relative_paths_for_every_rule_kind() {
        for kind in ["git-parents", "folder-root", "session-cwd", "session-mentions"] {
            for path in [".", "repos", "~someone/x"] {
                let mut value = fixture(kind).to_value();
                if kind == "git-parents" {
                    value["parents"] = json!([path]);
                } else {
                    value["root"] = json!(path);
                }
                assert_eq!(
                    Rule::parse(&value).unwrap_err(),
                    format!("path must be absolute: {path}")
                );
            }
        }
    }

    #[test]
    fn rejects_line_breaks_before_normalizing_rule_paths() {
        for kind in ["git-parents", "folder-root", "session-cwd", "session-mentions"] {
            for path in ["\n", "/work\n", "\r/work", "/work\r/project"] {
                let mut value = fixture(kind).to_value();
                if kind == "git-parents" {
                    value["parents"] = json!([path]);
                } else {
                    value["root"] = json!(path);
                }
                assert_eq!(Rule::parse(&value).unwrap_err(), "path contains a line break");
            }
        }
    }

    #[test]
    fn parses_all_kinds_defaults_and_normalized_paths() {
        for (kind, days, max) in [
            ("git-parents", 30, 10),
            ("folder-root", 21, 20),
            ("session-cwd", 30, 20),
            ("session-mentions", 14, 20),
        ] {
            let rule = fixture(kind);
            assert_eq!((rule.window_days, rule.max), (days, max));
            assert_eq!(Rule::from_value(&rule.to_value()), Some(rule));
        }
        let mut value = fixture("folder-root").to_value();
        value["root"] = json!("~/space dir/");
        let rule = Rule::from_value(&value).unwrap();
        assert_eq!(rule.directories(), vec![normalize_path("~/space dir")]);
        if let RuleKind::FolderRoot {
            depth,
            max_depth,
            exclude,
            ..
        } = rule.kind
        {
            assert_eq!((depth, max_depth, exclude), (2, 6, Exclude::default()));
        } else {
            panic!("wrong rule kind");
        }
    }

    #[test]
    fn rejects_unknown_missing_wrong_types_and_zero_without_removing_json() {
        let original = json!({"id":"future", "type":"future", "payload":[1,2]});
        let mut doc = LauncherDirsDoc::default();
        doc.rules.push(original.clone());
        assert!(Rule::from_value(&original).is_none());
        seed_defaults(&mut doc);
        assert_eq!(doc.rules, vec![original]);
        for field in ["id", "section", "mode", "enabled", "parents"] {
            let mut value = fixture("git-parents").to_value();
            value.as_object_mut().unwrap().remove(field);
            assert!(Rule::from_value(&value).is_none(), "{field}");
        }
        for (field, invalid) in [
            ("max", json!(0)),
            ("window_days", json!("30")),
            ("enabled", json!(null)),
            ("parents", json!([])),
            ("exclude", json!({"names":false})),
        ] {
            let mut value = fixture("git-parents").to_value();
            value[field] = invalid;
            assert!(Rule::from_value(&value).is_none(), "{field}");
        }
        let mut doc = LauncherDirsDoc::default();
        seed_defaults(&mut doc);
        assert_eq!(doc.rules.len(), 2);
        assert!(doc
            .rules
            .iter()
            .all(|value| Rule::from_value(value).unwrap().mode == Mode::Suggest));
    }
}
