use std::{collections::HashSet, fs, io::ErrorKind, path::Path, time::UNIX_EPOCH};

use super::model::{now, LauncherDirEntry, LauncherDirsDoc, Signal, Source};
use super::paths::{normalize_path, path_key};
use super::strings;

fn render_entry(entry: &LauncherDirEntry) -> String {
    let mut label: String = entry
        .label
        .chars()
        .map(|c| match c {
            '|' => strings::LABEL_SEPARATOR_REPLACEMENT,
            '\r' | '\n' => ' ',
            other => other,
        })
        .collect();
    if entry.source == Source::Auto {
        if let Some(date) = entry
            .seen_at
            .as_deref()
            .and_then(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        {
            let dot = if matches!(entry.signal, Some(Signal::Mention | Signal::Session)) {
                "\u{25cf}"
            } else {
                ""
            };
            label.push_str(&format!(" ({dot}{})", date.format("%m/%d")));
        }
    }
    let prefix = if entry.section == "anken" {
        strings::ANKEN_PREFIX
    } else {
        ""
    };
    format!(
        "{prefix}{label}{}{}\n",
        strings::FIELD_SEPARATOR,
        entry.path
    )
}

pub fn render_roots_txt(doc: &LauncherDirsDoc) -> String {
    let mut text = strings::ROOTS_TXT_HEADER
        .trim_end_matches(['\r', '\n'])
        .to_string();
    text.push('\n');
    let mut roots = HashSet::new();
    for root in doc
        .rules
        .iter()
        .filter_map(|rule| rule.get("root").and_then(|root| root.as_str()))
    {
        let root = normalize_path(root);
        if !root.is_empty() && !root.contains(['\r', '\n']) && roots.insert(path_key(&root)) {
            text.push_str(&format!("{} {root}\n", strings::SHORT_ROOT_KEY));
        }
    }
    for section in &doc.sections {
        for entry in doc
            .entries
            .iter()
            .filter(|entry| entry.section == section.id && entry.source == Source::Manual)
        {
            text.push_str(&render_entry(entry));
        }
        let mut auto: Vec<_> = doc
            .entries
            .iter()
            .filter(|entry| entry.section == section.id && entry.source == Source::Auto)
            .collect();
        auto.sort_by(|a, b| {
            b.seen_at
                .cmp(&a.seen_at)
                .then_with(|| b.added_at.cmp(&a.added_at))
        });
        let legacy = match section.id.as_str() {
            "dev" => Some((
                strings::LEGACY_DEV_RULE_ID,
                strings::LEGACY_DEV_BEGIN,
                strings::LEGACY_DEV_END,
            )),
            "anken" => Some((
                strings::LEGACY_ANKEN_RULE_ID,
                strings::LEGACY_ANKEN_BEGIN,
                strings::LEGACY_ANKEN_END,
            )),
            _ => None,
        };
        let (legacy_auto, other_auto): (Vec<_>, Vec<_>) = auto.into_iter().partition(|entry| {
            legacy.is_some_and(|(rule, _, _)| entry.rule_id.as_deref() == Some(rule))
        });
        if let Some((_, begin, end)) = legacy {
            if !legacy_auto.is_empty() {
                text.push_str(&format!("{begin} ===\n"));
                for entry in legacy_auto {
                    text.push_str(&render_entry(entry));
                }
                text.push_str(&format!("{end} ===\n"));
            }
        }
        for entry in other_auto {
            text.push_str(&render_entry(entry));
        }
    }
    text
}

pub fn roots_mtime_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

pub fn write_roots_txt(runtime_dir: &Path, doc: &mut LauncherDirsDoc) -> Result<(), String> {
    let path = runtime_dir.join("launch-roots.txt");
    let text = render_roots_txt(doc);
    let changed = match fs::read(&path) {
        Ok(contents) => contents != text.as_bytes(),
        Err(error) if error.kind() == ErrorKind::NotFound => true,
        Err(error) => return Err(error.to_string()),
    };
    if changed {
        let tmp = runtime_dir.join("launch-roots.txt.tmp");
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        doc.export.roots_txt_written_at = Some(now());
    }
    doc.export.roots_txt_mtime_ms = roots_mtime_ms(&path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::import::{initial_import, merge_external, parse_roots_txt};
    use super::*;

    fn legacy_document() -> LauncherDirsDoc {
        let mark = chrono::Local::now().format("%m/%d");
        let mut doc = initial_import(&parse_roots_txt(&format!(
            "Manual|C:/manual\n{} ===\nKeep ({mark})|C:/keep\nRemove|C:/remove\n{} ===\n{}Client|C:/client\n{} ===\n{}Legacy ({mark})|C:/legacy-client\n{} ===\n",
            strings::LEGACY_DEV_BEGIN,
            strings::LEGACY_DEV_END,
            strings::ANKEN_PREFIX,
            strings::LEGACY_ANKEN_BEGIN,
            strings::ANKEN_PREFIX,
            strings::LEGACY_ANKEN_END,
        )));
        let mut future = LauncherDirEntry::manual("dev", "Future", "C:/future");
        future.source = Source::Auto;
        future.rule_id = Some("future-rule".to_string());
        doc.entries.push(future);
        doc
    }

    #[test]
    fn legacy_blocks_round_trip_without_changing_the_document() {
        let mut doc = legacy_document();
        let before = doc.clone();
        let text = render_roots_txt(&doc);
        for marker in [
            strings::LEGACY_DEV_BEGIN,
            strings::LEGACY_DEV_END,
            strings::LEGACY_ANKEN_BEGIN,
            strings::LEGACY_ANKEN_END,
        ] {
            assert!(text.lines().any(|line| line == format!("{marker} ===")));
        }
        assert!(!text.contains("dev: "));
        let rows = parse_roots_txt(&text);
        assert_eq!(
            rows.iter()
                .find(|row| row.path == "C:/keep")
                .unwrap()
                .legacy,
            Some("dev")
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.path == "C:/legacy-client")
                .unwrap()
                .legacy,
            Some("anken")
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.path == "C:/future")
                .unwrap()
                .legacy,
            None
        );
        assert!(!merge_external(&mut doc, &rows));
        assert_eq!(doc, before);
    }

    #[test]
    fn replacing_only_a_legacy_block_preserves_manual_and_future_auto_entries() {
        let mut doc = legacy_document();
        let before = doc.clone();
        let text = render_roots_txt(&doc);
        let mut edited = String::new();
        let mut inside = false;
        for line in text.lines() {
            if line.starts_with(strings::LEGACY_DEV_BEGIN) {
                inside = true;
                edited.push_str(line);
                edited.push('\n');
                let mark = chrono::Local::now().format("%m/%d");
                edited.push_str(&format!(
                    "Updated (\u{25cf}{mark})|C:/keep\nAdded|C:/added\n"
                ));
            } else if line.starts_with(strings::LEGACY_DEV_END) {
                inside = false;
                edited.push_str(line);
                edited.push('\n');
            } else if !inside {
                edited.push_str(line);
                edited.push('\n');
            }
        }
        assert!(merge_external(&mut doc, &parse_roots_txt(&edited)));
        for path in ["C:/manual", "C:/client", "C:/future", "C:/legacy-client"] {
            assert_eq!(
                doc.entries.iter().find(|entry| entry.path == path),
                before.entries.iter().find(|entry| entry.path == path)
            );
        }
        let kept = doc
            .entries
            .iter()
            .find(|entry| entry.path == "C:/keep")
            .unwrap();
        let previous = before
            .entries
            .iter()
            .find(|entry| entry.path == "C:/keep")
            .unwrap();
        assert_eq!(kept.id, previous.id);
        assert_eq!(kept.added_at, previous.added_at);
        assert_eq!(kept.label, "Updated");
        assert_eq!(kept.signal, Some(Signal::Mention));
        assert!(!doc.entries.iter().any(|entry| entry.path == "C:/remove"));
        assert_eq!(
            doc.entries
                .iter()
                .find(|entry| entry.path == "C:/added")
                .unwrap()
                .rule_id
                .as_deref(),
            Some(strings::LEGACY_DEV_RULE_ID)
        );
    }

    #[test]
    fn exports_without_legacy_entries_have_no_auto_markers() {
        assert!(!render_roots_txt(&LauncherDirsDoc::default()).contains("AUTO-"));
        let mut doc = legacy_document();
        doc.entries.retain(|entry| {
            entry.source == Source::Manual || entry.rule_id.as_deref() == Some("future-rule")
        });
        assert!(!render_roots_txt(&doc).contains("AUTO-"));
    }

    #[test]
    fn renders_sections_manual_order_marks_sanitized_labels_and_short_roots() {
        let mut doc = LauncherDirsDoc::default();
        let mut old = LauncherDirEntry::manual("dev", "Old", "C:/old");
        old.source = Source::Auto;
        old.signal = Some(Signal::Folder);
        old.seen_at = Some("2026-09-01".to_string());
        old.added_at = "2026-09-01T00:00:00+09:00".to_string();
        let mut newer = old.clone();
        newer.label = "Newer".to_string();
        newer.path = "C:/newer".to_string();
        newer.added_at = "2026-09-02T00:00:00+09:00".to_string();
        let mut newest = old.clone();
        newest.label = "Newest".to_string();
        newest.path = "C:/newest".to_string();
        newest.seen_at = Some("2026-09-05".to_string());
        newest.signal = Some(Signal::Session);
        let manual = LauncherDirEntry::manual("dev", "A|B\r\nC", "C:/manual");
        let client = LauncherDirEntry::manual("anken", "Client", "C:/client");
        doc.entries = vec![old, newest, newer, manual, client];
        doc.rules = vec![
            serde_json::json!({"root":"C:\\work\\"}),
            serde_json::json!({"root":"/c/work"}),
            serde_json::json!({"root":42}),
        ];
        let text = render_roots_txt(&doc);
        assert!(text.starts_with(strings::ROOTS_TXT_HEADER));
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with(strings::SHORT_ROOT_KEY))
                .count(),
            1
        );
        let rows: Vec<_> = text.lines().filter(|line| !line.starts_with('#')).collect();
        assert_eq!(
            rows,
            vec![
                "A｜B  C|C:/manual",
                "Newest (●09/05)|C:/newest",
                "Newer (09/01)|C:/newer",
                "Old (09/01)|C:/old",
                "案件: Client|C:/client"
            ]
        );
        assert!(text.ends_with('\n'));
        assert!(!text.ends_with("\n\n"));
        doc.sections.reverse();
        assert_eq!(
            render_roots_txt(&doc)
                .lines()
                .find(|line| !line.starts_with('#')),
            Some("案件: Client|C:/client")
        );
    }

    #[test]
    fn mention_and_git_marks_and_absent_dates() {
        let mut entry = LauncherDirEntry::manual("dev", "Repo", "C:/repo");
        entry.source = Source::Auto;
        entry.signal = Some(Signal::Mention);
        assert_eq!(render_entry(&entry), "Repo|C:/repo\n");
        entry.seen_at = Some("2026-02-03".to_string());
        assert_eq!(render_entry(&entry), "Repo (●02/03)|C:/repo\n");
        entry.signal = Some(Signal::Git);
        assert_eq!(render_entry(&entry), "Repo (02/03)|C:/repo\n");
        entry.source = Source::Manual;
        assert_eq!(render_entry(&entry), "Repo|C:/repo\n");
    }

    #[test]
    fn writes_atomically_and_records_the_files_actual_mtime() {
        let runtime = tempfile::tempdir().unwrap();
        let mut doc = LauncherDirsDoc::default();
        write_roots_txt(runtime.path(), &mut doc).unwrap();
        assert_eq!(
            doc.export.roots_txt_mtime_ms,
            roots_mtime_ms(&runtime.path().join("launch-roots.txt"))
        );
        assert!(chrono::DateTime::parse_from_rfc3339(
            doc.export.roots_txt_written_at.as_deref().unwrap()
        )
        .is_ok());
        assert!(!runtime.path().join("launch-roots.txt.tmp").exists());
    }

    #[test]
    fn unchanged_txt_keeps_its_timestamp_but_refreshes_the_recorded_mtime() {
        let runtime = tempfile::tempdir().unwrap();
        let mut doc = LauncherDirsDoc::default();
        write_roots_txt(runtime.path(), &mut doc).unwrap();
        let path = runtime.path().join("launch-roots.txt");
        let stamp = fs::metadata(&path).unwrap().modified().unwrap();
        let written_at = doc.export.roots_txt_written_at.clone();
        doc.export.roots_txt_mtime_ms = None;
        write_roots_txt(runtime.path(), &mut doc).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), stamp);
        assert_eq!(doc.export.roots_txt_mtime_ms, roots_mtime_ms(&path));
        assert_eq!(doc.export.roots_txt_written_at, written_at);
        assert!(!runtime.path().join("launch-roots.txt.tmp").exists());
    }
}
