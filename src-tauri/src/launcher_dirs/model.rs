use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::paths::{folder_name, normalize_path, path_key};
use super::strings;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Manual,
    Auto,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Signal {
    Git,
    Folder,
    Session,
    Mention,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LauncherDirSection {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LauncherDirEntry {
    pub id: String,
    pub section: String,
    pub label: String,
    pub path: String,
    pub source: Source,
    pub added_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<Signal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_at: Option<String>,
}

pub fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

impl LauncherDirEntry {
    pub fn manual(section: &str, label: &str, path: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().simple().to_string(),
            section: section.to_string(),
            label: label.to_string(),
            path: normalize_path(path),
            source: Source::Manual,
            added_at: now(),
            rule_id: None,
            signal: None,
            seen_at: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportState {
    pub roots_txt_mtime_ms: Option<u64>,
    pub roots_txt_written_at: Option<String>,
    pub last_external_merge_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LauncherDirsDoc {
    pub version: u32,
    pub sections: Vec<LauncherDirSection>,
    pub entries: Vec<LauncherDirEntry>,
    #[serde(default)]
    pub ignored_paths: Vec<String>,
    #[serde(default)]
    pub rules: Vec<serde_json::Value>,
    #[serde(default)]
    pub last_scan: Option<serde_json::Value>,
    #[serde(default)]
    pub export: ExportState,
}

impl Default for LauncherDirsDoc {
    fn default() -> Self {
        Self {
            version: 1,
            sections: strings::DEFAULT_SECTIONS
                .into_iter()
                .map(|(id, label)| LauncherDirSection {
                    id: id.to_string(),
                    label: label.to_string(),
                })
                .collect(),
            entries: Vec::new(),
            ignored_paths: Vec::new(),
            rules: Vec::new(),
            last_scan: None,
            export: ExportState::default(),
        }
    }
}

fn checked_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        Err("label is empty".to_string())
    } else {
        Ok(label.to_string())
    }
}

impl LauncherDirsDoc {
    pub fn set_section_label(&mut self, section_id: &str, label: &str) -> Result<(), String> {
        let label = checked_label(label)?;
        let section = self
            .sections
            .iter_mut()
            .find(|section| section.id == section_id)
            .ok_or_else(|| "unknown section".to_string())?;
        section.label = label;
        Ok(())
    }

    pub fn add_entry(
        &mut self,
        section_id: &str,
        path: &str,
        label: Option<&str>,
    ) -> Result<(), String> {
        if !self.sections.iter().any(|section| section.id == section_id) {
            return Err("unknown section".to_string());
        }
        let path = normalize_path(path);
        if !Path::new(&path).is_dir() {
            return Err("not a directory".to_string());
        }
        let key = path_key(&path);
        if let Some(entry) = self
            .entries
            .iter()
            .find(|entry| path_key(&entry.path) == key)
        {
            return Err(format!("already registered in {}", entry.section));
        }
        let label = checked_label(label.unwrap_or(&folder_name(&path)))?;
        self.ignored_paths
            .retain(|ignored| path_key(ignored) != key);
        self.entries
            .push(LauncherDirEntry::manual(section_id, &label, &path));
        Ok(())
    }

    pub fn update_entry(&mut self, id: &str, label: &str) -> Result<(), String> {
        let label = checked_label(label)?;
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "unknown entry".to_string())?;
        entry.label = label;
        Ok(())
    }

    pub fn remove_entry(&mut self, id: &str) {
        self.entries.retain(|entry| entry.id != id);
    }

    pub fn move_entry(&mut self, id: &str, direction: &str) -> Result<(), String> {
        if direction != "up" && direction != "down" {
            return Err("invalid direction".to_string());
        }
        let index = self
            .entries
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "unknown entry".to_string())?;
        let entry = &self.entries[index];
        if entry.source != Source::Manual {
            return Err("automatic entries cannot be moved".to_string());
        }
        let indices: Vec<usize> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, candidate)| {
                candidate.section == entry.section && candidate.source == Source::Manual
            })
            .map(|(index, _)| index)
            .collect();
        let position = indices
            .iter()
            .position(|&candidate| candidate == index)
            .unwrap();
        let other = if direction == "up" {
            position.checked_sub(1)
        } else {
            Some(position + 1)
        };
        if let Some(other) = other.and_then(|position| indices.get(position)) {
            self.entries.swap(index, *other);
        }
        Ok(())
    }

    pub fn pin_entry(&mut self, id: &str) -> Result<(), String> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "unknown entry".to_string())?;
        if self.entries[index].source == Source::Manual {
            return Ok(());
        }
        let mut entry = self.entries.remove(index);
        entry.source = Source::Manual;
        entry.rule_id = None;
        entry.signal = None;
        entry.seen_at = None;
        let position = self
            .entries
            .iter()
            .rposition(|candidate| {
                candidate.section == entry.section && candidate.source == Source::Manual
            })
            .map(|index| index + 1)
            .unwrap_or(self.entries.len());
        self.entries.insert(position, entry);
        Ok(())
    }

    pub fn ignore_path(&mut self, path: &str) {
        let path = normalize_path(path);
        let key = path_key(&path);
        if !self
            .ignored_paths
            .iter()
            .any(|ignored| path_key(ignored) == key)
        {
            self.ignored_paths.push(path);
        }
        self.entries.retain(|entry| path_key(&entry.path) != key);
    }

    pub fn unignore_path(&mut self, path: &str) {
        let key = path_key(path);
        self.ignored_paths
            .retain(|ignored| path_key(ignored) != key);
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LauncherDirsView {
    pub doc: LauncherDirsDoc,
    pub entries_exist: Vec<(String, bool)>,
    pub json_path: String,
    pub roots_txt_path: String,
}

impl LauncherDirsView {
    pub fn new(runtime_dir: &Path, doc: LauncherDirsDoc) -> Self {
        let display_path = |path: PathBuf| normalize_path(&path.to_string_lossy());
        Self {
            entries_exist: doc
                .entries
                .iter()
                .map(|entry| (entry.id.clone(), Path::new(&entry.path).is_dir()))
                .collect(),
            doc,
            json_path: display_path(runtime_dir.join("launch-dirs.json")),
            roots_txt_path: display_path(runtime_dir.join("launch-roots.txt")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip_defaults_and_automatic_entries() {
        let mut doc = LauncherDirsDoc::default();
        let empty = serde_json::to_string(&doc).unwrap();
        assert_eq!(
            serde_json::from_str::<LauncherDirsDoc>(&empty).unwrap(),
            doc
        );
        assert_eq!(doc.sections[0].label, strings::DEFAULT_SECTIONS[0].1);
        let mut auto = LauncherDirEntry::manual("anken", "Client", "C:/client");
        auto.source = Source::Auto;
        auto.signal = Some(Signal::Session);
        auto.seen_at = Some("2026-09-05".to_string());
        auto.rule_id = Some("future-rule".to_string());
        doc.entries = vec![LauncherDirEntry::manual("dev", "Repo", "C:/repo"), auto];
        doc.rules = vec![serde_json::json!({"unknown": [1, {"nested": true}]})];
        doc.last_scan = Some(serde_json::json!({"anything": 42}));
        let value = serde_json::to_value(&doc).unwrap();
        assert_eq!(value["entries"][1]["source"], "auto");
        assert!(value["entries"][0].get("rule_id").is_none());
        assert!(value["entries"][0].get("signal").is_none());
        assert!(value["entries"][0].get("seen_at").is_none());
        assert!(value["entries"][0].get("exists").is_none());
        assert_eq!(
            serde_json::from_value::<LauncherDirsDoc>(value).unwrap(),
            doc
        );
        assert_eq!(
            uuid::Uuid::parse_str(&doc.entries[0].id)
                .unwrap()
                .get_version_num(),
            4
        );
        assert_eq!(doc.entries[0].id.len(), 32);
    }

    #[test]
    fn add_validates_and_unignores_the_normalized_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy();
        let mut doc = LauncherDirsDoc::default();
        doc.ignore_path(&path);
        doc.add_entry("dev", &format!("{path}/"), None).unwrap();
        assert!(doc.ignored_paths.is_empty());
        assert_eq!(doc.entries[0].label, folder_name(&path));
        assert_eq!(
            doc.add_entry("anken", &path, None).unwrap_err(),
            "already registered in dev"
        );
        assert_eq!(
            doc.add_entry("dev", &dir.path().join("missing").to_string_lossy(), None)
                .unwrap_err(),
            "not a directory"
        );
        assert!(doc.add_entry("other", &path, None).is_err());
        assert!(doc.set_section_label("dev", " \n ").is_err());
        assert!(doc.set_section_label("other", "Repos").is_err());
        doc.set_section_label("dev", " Repos ").unwrap();
        let id = doc.entries[0].id.clone();
        assert!(doc.update_entry(&id, " ").is_err());
        doc.update_entry(&id, " Renamed ").unwrap();
        assert_eq!(doc.entries[0].label, "Renamed");
        assert_eq!(doc.sections[0].label, "Repos");
        assert!(LauncherDirsView::new(dir.path(), doc).entries_exist[0].1);
    }

    #[test]
    fn move_pin_and_ignore_preserve_other_sections_and_manual_order() {
        let mut doc = LauncherDirsDoc::default();
        let first = LauncherDirEntry::manual("dev", "first", "C:/first");
        let other = LauncherDirEntry::manual("anken", "other", "C:/other");
        let last = LauncherDirEntry::manual("dev", "last", "C:/last");
        let mut auto = LauncherDirEntry::manual("dev", "auto", "C:/auto");
        auto.source = Source::Auto;
        auto.rule_id = Some(strings::LEGACY_DEV_RULE_ID.to_string());
        auto.signal = Some(Signal::Git);
        auto.seen_at = Some("2026-09-05".to_string());
        doc.entries = vec![first.clone(), other.clone(), auto.clone(), last.clone()];
        doc.move_entry(&last.id, "up").unwrap();
        assert_eq!(doc.entries[0].id, last.id);
        assert_eq!(doc.entries[1].id, other.id);
        let moved = doc.clone();
        doc.move_entry(&last.id, "up").unwrap();
        assert_eq!(doc, moved);
        assert!(doc.move_entry(&auto.id, "down").is_err());
        assert!(doc.move_entry(&first.id, "sideways").is_err());
        doc.move_entry(&last.id, "down").unwrap();
        assert_eq!(doc.entries[0].id, first.id);
        doc.pin_entry(&auto.id).unwrap();
        assert_eq!(
            doc.entries
                .iter()
                .filter(|e| e.section == "dev")
                .map(|e| &e.id)
                .collect::<Vec<_>>(),
            vec![&first.id, &last.id, &auto.id]
        );
        let pinned = doc.clone();
        doc.pin_entry(&auto.id).unwrap();
        assert_eq!(doc, pinned);
        let entry = doc.entries.iter().find(|e| e.id == auto.id).unwrap();
        assert_eq!(entry.source, Source::Manual);
        assert_eq!(
            (&entry.rule_id, &entry.signal, &entry.seen_at),
            (&None, &None, &None)
        );
        doc.ignore_path("/c/auto/");
        doc.ignore_path("C:\\auto");
        assert_eq!(doc.ignored_paths, vec!["C:/auto"]);
        assert!(!doc.entries.iter().any(|e| e.id == auto.id));
        doc.unignore_path("/c/auto");
        assert!(doc.ignored_paths.is_empty());
        doc.remove_entry("absent");
        doc.remove_entry(&first.id);
        assert_eq!(doc.entries.len(), 2);
    }
}
