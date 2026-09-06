use std::collections::{HashMap, HashSet};

use chrono::{Datelike, NaiveDate};

use super::model::{LauncherDirEntry, LauncherDirsDoc, Signal, Source};
use super::paths::{normalize_path, path_key};
use super::strings;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedRow {
    pub section: String,
    pub label: String,
    pub path: String,
    pub legacy: Option<&'static str>,
    pub signal: Option<Signal>,
    pub seen_at: Option<String>,
}

fn split_mark(label: &str, today: NaiveDate) -> (String, Option<Signal>, Option<String>) {
    let plain = || (label.to_string(), None, None);
    let Some((name, suffix)) = label.rsplit_once('(') else {
        return plain();
    };
    let Some(mark) = suffix.strip_suffix(')') else {
        return plain();
    };
    let (signal, date) = if let Some(date) = mark.strip_prefix('\u{25cf}') {
        (Signal::Mention, date)
    } else if let Some(date) = mark.strip_prefix('~') {
        (Signal::Folder, date)
    } else {
        (Signal::Git, mark)
    };
    let bytes = date.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b'/'
        || !bytes[..2].iter().chain(&bytes[3..]).all(u8::is_ascii_digit)
    {
        return plain();
    }
    let month: u32 = date[..2].parse().unwrap();
    let day: u32 = date[3..].parse().unwrap();
    let seen = [today.year(), today.year() - 1]
        .into_iter()
        .filter_map(|year| NaiveDate::from_ymd_opt(year, month, day))
        .find(|date| *date <= today);
    match seen {
        Some(seen) => (
            name.trim_end().to_string(),
            Some(signal),
            Some(seen.to_string()),
        ),
        None => plain(),
    }
}

pub fn parse_roots_txt(contents: &str) -> Vec<ImportedRow> {
    parse_roots_at(contents, chrono::Local::now().date_naive())
}

fn parse_roots_at(contents: &str, today: NaiveDate) -> Vec<ImportedRow> {
    let mut rows = Vec::new();
    let mut legacy = None;
    for line in contents.lines() {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.starts_with(strings::LEGACY_DEV_BEGIN) {
            legacy = Some("dev");
            continue;
        }
        if line.starts_with(strings::LEGACY_ANKEN_BEGIN) {
            legacy = Some("anken");
            continue;
        }
        if line.starts_with(strings::LEGACY_DEV_END) || line.starts_with(strings::LEGACY_ANKEN_END)
        {
            legacy = None;
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((label, path)) = line.split_once(strings::FIELD_SEPARATOR) else {
            continue;
        };
        let (label, path) = (label.trim(), path.trim());
        if label.is_empty() || path.is_empty() {
            continue;
        }
        let (section, label) = match label.strip_prefix(strings::ANKEN_PREFIX.trim_end()) {
            Some(label) => ("anken", label.trim()),
            None => ("dev", label),
        };
        let label = if legacy == Some("dev") {
            label
                .strip_prefix(strings::LEGACY_DEV_LABEL_PREFIX)
                .unwrap_or(label)
                .trim()
        } else {
            label
        };
        let (label, signal, seen_at) = if legacy.is_some() {
            split_mark(label, today)
        } else {
            (label.to_string(), None, None)
        };
        if label.is_empty() {
            continue;
        }
        rows.push(ImportedRow {
            section: section.to_string(),
            label,
            path: normalize_path(path),
            legacy,
            signal,
            seen_at,
        });
    }
    rows
}

pub fn parse_mru(contents: &str) -> Vec<String> {
    contents
        .lines()
        .map(|line| line.trim_start_matches('\u{feff}').trim())
        .filter(|line| !line.is_empty())
        .map(normalize_path)
        .collect()
}

fn from_row(row: &ImportedRow) -> LauncherDirEntry {
    let mut entry = LauncherDirEntry::manual(&row.section, &row.label, &row.path);
    apply_row(&mut entry, row);
    entry
}

fn apply_row(entry: &mut LauncherDirEntry, row: &ImportedRow) {
    entry.section = row.section.clone();
    entry.label = row.label.clone();
    entry.path = normalize_path(&row.path);
    if let Some(legacy) = row.legacy {
        entry.source = Source::Auto;
        entry.rule_id = Some(
            if legacy == "dev" {
                strings::LEGACY_DEV_RULE_ID
            } else {
                strings::LEGACY_ANKEN_RULE_ID
            }
            .to_string(),
        );
        entry.signal = row.signal.clone();
        entry.seen_at = row.seen_at.clone();
    }
}

pub fn initial_import(rows: &[ImportedRow]) -> LauncherDirsDoc {
    let mut doc = LauncherDirsDoc::default();
    super::rules::seed_defaults(&mut doc);
    let manual_keys: HashSet<_> = rows.iter()
        .filter(|row| row.legacy.is_none())
        .map(|row| path_key(&row.path))
        .collect();
    let mut keys = HashSet::new();
    for row in rows {
        let key = path_key(&row.path);
        if row.legacy.is_some() && manual_keys.contains(&key) {
            continue;
        }
        if keys.insert(key) {
            doc.entries.push(from_row(row));
        }
    }
    doc
}

fn is_legacy(entry: &LauncherDirEntry) -> bool {
    entry.source == Source::Auto
        && matches!(
            entry.rule_id.as_deref(),
            Some(strings::LEGACY_DEV_RULE_ID | strings::LEGACY_ANKEN_RULE_ID)
        )
}

pub fn merge_external(doc: &mut LauncherDirsDoc, rows: &[ImportedRow]) -> bool {
    let before = &doc.entries;
    let registered: HashMap<String, &LauncherDirEntry> = before
        .iter()
        .map(|entry| (path_key(&entry.path), entry))
        .collect();
    let ignored: HashSet<String> = doc
        .ignored_paths
        .iter()
        .map(|path| path_key(path))
        .collect();
    let previous: HashMap<String, &LauncherDirEntry> = before
        .iter()
        .filter(|entry| is_legacy(entry))
        .map(|entry| (path_key(&entry.path), entry))
        .collect();
    let mut entries: Vec<LauncherDirEntry> = before
        .iter()
        .filter(|entry| !is_legacy(entry))
        .cloned()
        .collect();
    let mut keys: HashSet<String> = entries.iter().map(|entry| path_key(&entry.path)).collect();
    for row in rows.iter().filter(|row| row.legacy.is_some()) {
        let key = path_key(&row.path);
        if ignored.contains(&key) || !keys.insert(key.clone()) {
            continue;
        }
        let mut entry = previous
            .get(&key)
            .map(|entry| (*entry).clone())
            .unwrap_or_else(|| from_row(row));
        apply_row(&mut entry, row);
        entries.push(entry);
    }
    for row in rows.iter().filter(|row| row.legacy.is_none()) {
        let key = path_key(&row.path);
        // Older exports flattened auto rows. A stale copy outside a newly written
        // legacy block must not resurrect a removed auto row as a manual row.
        if !registered.contains_key(&key) && !ignored.contains(&key) && keys.insert(key) {
            entries.push(from_row(row));
        }
    }
    // Export groups rows by section and source; that alone is not an edit.
    if before.len() == entries.len()
        && entries.iter().all(|entry| {
            registered
                .get(&path_key(&entry.path))
                .is_some_and(|previous| *previous == entry)
        })
    {
        return false;
    }
    doc.entries = entries;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 1, 2).unwrap()
    }

    #[test]
    fn splits_dev_and_anken_and_drops_comments() {
        let rows = parse_roots_at(
            concat!(
                "\u{feff}# comment\n\nmycmux (master)|C:/repo\n",
                "案件: 駿台/モモスタ/数学 (●01/01)|C:/math\n",
                "案件:東洋食品工業短期大学/2027年度入試|C:/toyo\n",
            ),
            today(),
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].section, "dev");
        assert_eq!(rows[0].label, "mycmux (master)");
        assert_eq!(rows[1].section, "anken");
        assert_eq!(
            rows[1].label,
            "\u{99ff}\u{53f0}/\u{30e2}\u{30e2}\u{30b9}\u{30bf}/\u{6570}\u{5b66} (\u{25cf}01/01)"
        );
        assert_eq!(rows[2].section, "anken");
    }

    #[test]
    fn drops_rows_missing_either_field() {
        assert!(
            parse_roots_txt("no-separator\n|C:/only/path\nlabel-only|\n案件: |C:/empty\n")
                .is_empty()
        );
    }

    #[test]
    fn keeps_a_path_that_contains_spaces_and_japanese() {
        let rows = parse_roots_txt("案件: なるゼミ/数学|C:/Users/example/エデュ・プラニング合同会社 Dropbox/なるゼミ/数学\n");
        assert_eq!(
            rows[0].path,
            "C:/Users/example/エデュ・プラニング合同会社 Dropbox/なるゼミ/数学"
        );
    }

    #[test]
    fn mru_keeps_order_and_drops_blanks() {
        assert_eq!(
            parse_mru("\u{feff}C:/a\n\n  C:/b  \n"),
            vec!["C:/a", "C:/b"]
        );
    }

    #[test]
    fn blocks_prefixes_marks_and_year_inference() {
        let rows = parse_roots_at(
            concat!(
                "manual (12/31)|C:/manual\n",
                "# === AUTO-DEV BEGIN (generated) ===\n",
                "dev: Repo (01/02)|/c/Repo/\n",
                "# === AUTO-DEV END ===\n",
                "dev: outside|C:/outside\n",
                "# === AUTO-ANKEN BEGIN (generated) ===\n",
                "案件: Mention (●12/31)|C:/mention\n",
                "案件: Folder (~01/03)|C:/folder\n",
                "# === AUTO-ANKEN END ===\n",
                "plain|C:/plain\n",
            ),
            today(),
        );
        assert_eq!(rows[0].legacy, None);
        assert_eq!(rows[0].label, "manual (12/31)");
        assert_eq!(rows[0].signal, None);
        assert_eq!(rows[0].seen_at, None);
        assert_eq!(rows[1].legacy, Some("dev"));
        assert_eq!(rows[1].label, "Repo");
        assert_eq!(rows[1].path, if cfg!(windows) { "C:/Repo" } else { "/c/Repo" });
        assert_eq!(rows[1].signal, Some(Signal::Git));
        assert_eq!(rows[1].seen_at.as_deref(), Some("2026-01-02"));
        assert_eq!(rows[2].label, "dev: outside");
        assert_eq!(rows[3].signal, Some(Signal::Mention));
        assert_eq!(rows[3].seen_at.as_deref(), Some("2025-12-31"));
        assert_eq!(rows[4].signal, Some(Signal::Folder));
        assert_eq!(rows[4].seen_at.as_deref(), Some("2025-01-03"));
        assert_eq!(rows[5].legacy, None);
        assert_eq!(
            split_mark("not a date (99/99)", today()).0,
            "not a date (99/99)"
        );
    }

    #[test]
    fn initial_import_prefers_later_manual_rows_at_their_original_positions() {
        let rows = parse_roots_at(concat!(
            "# === AUTO-DEV BEGIN\n",
            "dev: duplicate (01/01)|C:/same/\n",
            "dev: retained (01/01)|C:/retained\n",
            "# === AUTO-DEV END\n",
            "Middle|C:/middle\n",
            "Pinned|C:/same\n",
            "Last|C:/last\n",
        ), today());
        let doc = initial_import(&rows);
        assert_eq!(
            doc.entries.iter().map(|entry| entry.label.as_str()).collect::<Vec<_>>(),
            vec!["retained", "Middle", "Pinned", "Last"]
        );
        let pinned = &doc.entries[2];
        assert_eq!(pinned.path, "C:/same");
        assert_eq!(pinned.source, Source::Manual);
        assert!(pinned.rule_id.is_none());
        assert!(pinned.signal.is_none());
    }

    #[test]
    fn initial_import_preserves_file_order_and_first_path_wins() {
        let rows = parse_roots_at(
            concat!(
                "manual (01/01)|C:/same\n",
                "# === AUTO-DEV BEGIN\ndev: duplicate (01/01)|C:/same/\n",
                "dev: new (01/01)|C:/new\n# === AUTO-DEV END\n",
                "# === AUTO-ANKEN BEGIN\n案件: Client (~01/01)|C:/client\n# === AUTO-ANKEN END\n",
            ),
            today(),
        );
        let doc = initial_import(&rows);
        assert_eq!(doc.entries.len(), 3);
        assert_eq!(doc.entries[0].source, Source::Manual);
        assert!(doc.entries[0].signal.is_none());
        assert_eq!(
            doc.entries[1].rule_id.as_deref(),
            Some(strings::LEGACY_DEV_RULE_ID)
        );
        assert_eq!(
            doc.entries[2].rule_id.as_deref(),
            Some(strings::LEGACY_ANKEN_RULE_ID)
        );
    }

    #[test]
    fn manual_date_suffixes_are_labels_in_both_sections() {
        for label in ["foo (01/02)", "bar (~01/02)", "baz (\u{25cf}01/02)"] {
            let text = format!(
                "{label}|C:/manual-dev\n{}{label}|C:/manual-anken\n",
                strings::ANKEN_PREFIX
            );
            let rows = parse_roots_at(&text, today());
            assert_eq!(rows.len(), 2);
            for row in &rows {
                assert_eq!(row.label, label);
                assert_eq!(row.legacy, None);
                assert_eq!(row.signal, None);
                assert_eq!(row.seen_at, None);
            }
            let doc = initial_import(&rows);
            let exported = super::super::export::render_roots_txt(&doc);
            assert_eq!(parse_roots_at(&exported, today()), rows);
        }
    }

    #[test]
    fn external_merge_replaces_legacy_rows_preserving_ids_and_manual_entries() {
        let mut doc = initial_import(&parse_roots_at(
            concat!(
                "Manual|C:/manual\n# === AUTO-DEV BEGIN\n",
                "dev: Old (01/01)|C:/remaining\ndev: Removed|C:/removed\n",
                "dev: Pinned|C:/pinned\n# === AUTO-DEV END\n",
            ),
            today(),
        ));
        let id = doc.entries[1].id.clone();
        let added_at = doc.entries[1].added_at.clone();
        let pin_id = doc.entries[3].id.clone();
        doc.pin_entry(&pin_id).unwrap();
        doc.ignore_path("C:/ignored");
        let rows = parse_roots_at(
            concat!(
                "Removed|C:/removed\nOld|C:/remaining\nNew manual|C:/new-manual\n",
                "Ignored manual|C:/ignored\n# === AUTO-DEV BEGIN\n",
                "dev: Updated (~01/02)|C:/remaining\ndev: Added (01/02)|C:/added\n",
                "dev: Do not unpin|C:/pinned\ndev: Ignored|C:/ignored\n# === AUTO-DEV END\n",
            ),
            today(),
        );
        assert!(merge_external(&mut doc, &rows));
        assert_eq!(doc.entries.len(), 5);
        assert_eq!(doc.entries[0].label, "Manual");
        assert_eq!(doc.entries[1].label, "Pinned");
        let kept = doc.entries.iter().find(|entry| entry.id == id).unwrap();
        assert_eq!(kept.added_at, added_at);
        assert_eq!(kept.label, "Updated");
        assert_eq!(kept.signal, Some(Signal::Folder));
        assert_eq!(kept.seen_at.as_deref(), Some("2026-01-02"));
        assert!(!doc
            .entries
            .iter()
            .any(|e| e.path == "C:/removed" || e.path == "C:/ignored"));
        assert_eq!(doc.entries.last().unwrap().source, Source::Manual);
        // With no blocks in a newer file, the legacy rows are gone; manually
        // registered rows still survive even when absent from that file.
        merge_external(&mut doc, &[]);
        assert_eq!(doc.entries.len(), 3);
        assert!(!merge_external(&mut doc, &[]));
    }
}
