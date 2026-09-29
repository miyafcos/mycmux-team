use std::{fs, io::ErrorKind, path::Path, sync::Mutex, time::UNIX_EPOCH};

use super::export::{roots_txt_digest, write_roots_txt};
#[cfg(test)]
use super::export::roots_mtime_ms;
use super::import::{initial_import, merge_external, parse_mru, parse_roots_txt};
use super::model::{now, LauncherDirsDoc, LauncherDirsView};
use super::paths::{normalize_path, path_key};

static LOCK: Mutex<()> = Mutex::new(());

fn save_json(runtime_dir: &Path, doc: &LauncherDirsDoc, backup: bool) -> Result<(), String> {
    let path = runtime_dir.join("launch-dirs.json");
    let mut json = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    json.push('\n');
    let previous = match fs::read(&path) {
        Ok(contents) => Some(contents),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if previous.as_deref() == Some(json.as_bytes()) {
        return Ok(());
    }
    if backup && previous.is_some() {
        fs::copy(&path, runtime_dir.join("launch-dirs.json.bak")).map_err(|e| e.to_string())?;
    }
    let tmp = runtime_dir.join("launch-dirs.json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn persist(
    runtime_dir: &Path,
    doc: &mut LauncherDirsDoc,
    expected: Option<&[u8]>,
) -> Result<(), String> {
    // Commit the source before exporting it. A failed export cannot discard a
    // user's edit. Then persist the confirmed digest and mtime without rotating
    // the backup a second time, so .bak still holds the previous revision.
    save_json(runtime_dir, doc, true)?;
    write_roots_txt(runtime_dir, doc, expected)?;
    save_json(runtime_dir, doc, false)
}

fn backup_roots(runtime_dir: &Path) -> Result<(), String> {
    let roots = runtime_dir.join("launch-roots.txt");
    if !roots.exists() {
        return Ok(());
    }
    let backup = runtime_dir.join(format!(
        "launch-roots.txt.bak-{}",
        chrono::Local::now().format("%Y%m%d")
    ));
    if !backup.exists() {
        fs::copy(roots, backup).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn fresh_doc() -> LauncherDirsDoc {
    let mut doc = LauncherDirsDoc::default();
    super::rules::seed_defaults(&mut doc);
    doc
}

// Only called while LOCK is held (or with an isolated tempdir in unit tests).
fn load(runtime_dir: &Path) -> Result<LauncherDirsDoc, String> {
    fs::create_dir_all(runtime_dir).map_err(|e| e.to_string())?;
    let json_path = runtime_dir.join("launch-dirs.json");
    let mut doc = match fs::read(&json_path) {
        Ok(contents) => match serde_json::from_slice(&contents) {
            Ok(doc) => return Ok(doc),
            Err(error) => {
                let mut stamp = std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_secs();
                let mut corrupt = runtime_dir.join(format!("launch-dirs.json.corrupt-{stamp}"));
                while corrupt.exists() {
                    stamp += 1;
                    corrupt = runtime_dir.join(format!("launch-dirs.json.corrupt-{stamp}"));
                }
                fs::rename(&json_path, &corrupt).map_err(|e| e.to_string())?;
                crate::diag_warn!(
                    "launcher_dirs",
                    "Invalid ledger moved to {}: {error}",
                    corrupt.display()
                );
                let backup = fs::read(runtime_dir.join("launch-dirs.json.bak"))
                    .ok()
                    .and_then(|contents| serde_json::from_slice(&contents).ok());
                let (recovered, source) = if let Some(doc) = backup {
                    (doc, "launch-dirs.json.bak")
                } else if let Ok(contents) =
                    fs::read_to_string(runtime_dir.join("launch-roots.txt"))
                {
                    (
                        initial_import(&parse_roots_txt(&contents)),
                        "launch-roots.txt",
                    )
                } else {
                    (fresh_doc(), "empty defaults")
                };
                crate::diag_warn!(
                    "launcher_dirs",
                    "Recovered ledger in {} from {source}",
                    runtime_dir.display()
                );
                recovered
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => {
            match fs::read_to_string(runtime_dir.join("launch-roots.txt")) {
                Ok(contents) => initial_import(&parse_roots_txt(&contents)),
                Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::InvalidData) => fresh_doc(),
                Err(error) => return Err(error.to_string()),
            }
        }
        Err(error) => return Err(error.to_string()),
    };
    backup_roots(runtime_dir)?;
    persist(runtime_dir, &mut doc, None)?;
    Ok(doc)
}

fn sync_external(
    runtime_dir: &Path,
    doc: &mut LauncherDirsDoc,
) -> Result<(bool, Vec<u8>), String> {
    let snapshot = match fs::read(runtime_dir.join("launch-roots.txt")) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok((false, Vec::new())),
        Err(error) => return Err(error.to_string()),
    };
    // A failed export can leave our previous TXT behind after JSON was saved.
    if doc.export.roots_txt_digest.as_deref()
        .is_some_and(|digest| roots_txt_digest(&snapshot) == digest)
    {
        return Ok((false, snapshot));
    }
    if snapshot == super::export::render_roots_txt(doc).as_bytes() {
        return Ok((false, snapshot));
    }
    // Export preserves undecodable bytes by renaming them before replacement.
    let Ok(contents) = std::str::from_utf8(&snapshot) else {
        return Ok((false, snapshot));
    };
    let changed = merge_external(doc, &parse_roots_txt(contents));
    doc.export.last_external_merge_at = Some(now());
    Ok((changed, snapshot))
}

pub fn with_doc<F>(f: F) -> Result<LauncherDirsView, String>
where
    F: FnOnce(&mut LauncherDirsDoc) -> Result<(), String>,
{
    with_doc_at(&crate::test_profile::runtime_dir()?, f)
}

fn with_doc_at<F>(runtime_dir: &Path, f: F) -> Result<LauncherDirsView, String>
where
    F: FnOnce(&mut LauncherDirsDoc) -> Result<(), String>,
{
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut doc = load(runtime_dir)?;
    let (external_imported, snapshot) = sync_external(runtime_dir, &mut doc)?;
    f(&mut doc)?;
    super::scan::prune_candidates(&mut doc);
    persist(runtime_dir, &mut doc, Some(&snapshot))?;
    let mut view = LauncherDirsView::new(runtime_dir, doc);
    view.external_imported = external_imported;
    Ok(view)
}

pub fn record_dir_mru(runtime_dir: &Path, path: &str) -> Result<(), String> {
    // ponytail: last-writer-wins across bash and Rust; add a runtime-dir lock file if lost MRU rows ever matter
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let path = normalize_path(path);
    if path.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(runtime_dir).map_err(|e| e.to_string())?;
    let file = runtime_dir.join("launch-dirs-mru.txt");
    let contents = match fs::read_to_string(&file) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.to_string()),
    };
    let mut keys = std::collections::HashSet::from([path_key(&path)]);
    let mut paths = vec![path];
    paths.extend(
        parse_mru(&contents)
            .into_iter()
            .filter(|path| keys.insert(path_key(path)))
            .take(7),
    );
    let tmp = runtime_dir.join(format!("launch-dirs-mru.txt.tmp-{}", std::process::id()));
    fs::write(&tmp, format!("{}\n", paths.join("\n"))).map_err(|e| e.to_string())?;
    fs::rename(tmp, file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::model::Source;
    use super::*;

    #[test]
    fn defaults_are_seeded_only_when_creating_json_or_importing_txt() {
        for with_txt in [false, true] {
            let root = tempfile::tempdir().unwrap();
            if with_txt { fs::write(root.path().join("launch-roots.txt"), "Manual|C:/manual\n").unwrap(); }
            let doc = load(root.path()).unwrap();
            assert_eq!(doc.rules.len(), 2);
            assert!(doc.rules.iter().all(|value| value["mode"] == "suggest"));
        }
        let root = tempfile::tempdir().unwrap();
        let existing = LauncherDirsDoc::default();
        fs::write(root.path().join("launch-dirs.json"), serde_json::to_vec(&existing).unwrap()).unwrap();
        assert!(load(root.path()).unwrap().rules.is_empty());
    }

    #[test]
    fn fresh_profile_creates_an_empty_document_and_derived_file() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("profile");
        let view = with_doc_at(&runtime, |_| Ok(())).unwrap();
        assert!(view.doc.entries.is_empty());
        assert!(Path::new(&view.json_path).is_file());
        assert!(Path::new(&view.roots_txt_path).is_file());
        let again = with_doc_at(&runtime, |_| Ok(())).unwrap();
        assert_eq!(again.doc.export.last_external_merge_at, None);
        assert_eq!(
            again.doc.export.roots_txt_mtime_ms,
            roots_mtime_ms(Path::new(&again.roots_txt_path))
        );
    }

    #[test]
    fn unchanged_gets_preserve_json_and_txt_mtimes_without_creating_a_backup() {
        let runtime = tempfile::tempdir().unwrap();
        let first = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        let json_time = fs::metadata(&first.json_path).unwrap().modified().unwrap();
        let txt_time = fs::metadata(&first.roots_txt_path)
            .unwrap()
            .modified()
            .unwrap();
        for _ in 0..2 {
            let again = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
            assert_eq!(again.doc, first.doc);
            assert_eq!(
                fs::metadata(&again.json_path).unwrap().modified().unwrap(),
                json_time
            );
            assert_eq!(
                fs::metadata(&again.roots_txt_path)
                    .unwrap()
                    .modified()
                    .unwrap(),
                txt_time
            );
            assert!(!runtime.path().join("launch-dirs.json.bak").exists());
        }
    }

    #[test]
    fn initial_migration_backs_up_txt_once_and_keeps_auto_on_repeated_get() {
        let runtime = tempfile::tempdir().unwrap();
        let txt = "Manual|C:/manual\n# === AUTO-DEV BEGIN\ndev: Auto (01/01)|C:/auto\n# === AUTO-DEV END\n";
        fs::write(runtime.path().join("launch-roots.txt"), txt).unwrap();
        let view = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        let backup = runtime.path().join(format!(
            "launch-roots.txt.bak-{}",
            chrono::Local::now().format("%Y%m%d")
        ));
        assert_eq!(fs::read_to_string(&backup).unwrap(), txt);
        assert_eq!(view.doc.entries[1].source, Source::Auto);
        let again = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        assert_eq!(again.doc.entries, view.doc.entries);
        assert_eq!(again.doc.export.last_external_merge_at, None);
        backup_roots(runtime.path()).unwrap();
        assert_eq!(fs::read_to_string(backup).unwrap(), txt);
    }

    #[test]
    fn edits_keep_one_previous_json_revision_and_unknown_phase_two_data() {
        let runtime = tempfile::tempdir().unwrap();
        let first = with_doc_at(runtime.path(), |doc| {
            doc.rules = vec![serde_json::json!({"root":"C:/future", "custom":[1,2]})];
            doc.last_scan = Some(serde_json::json!({"future":true}));
            Ok(())
        })
        .unwrap();
        let second =
            with_doc_at(runtime.path(), |doc| doc.set_section_label("dev", "Repos")).unwrap();
        let old: LauncherDirsDoc = serde_json::from_str(
            &fs::read_to_string(runtime.path().join("launch-dirs.json.bak")).unwrap(),
        )
        .unwrap();
        assert_eq!(old, first.doc);
        assert_eq!(second.doc.rules, first.doc.rules);
        assert_eq!(second.doc.last_scan, first.doc.last_scan);
        let disk: LauncherDirsDoc =
            serde_json::from_str(&fs::read_to_string(&second.json_path).unwrap()).unwrap();
        assert_eq!(disk, second.doc);
        assert!(!runtime.path().join("launch-dirs.json.tmp").exists());
        let backup_path = runtime.path().join("launch-dirs.json.bak");
        let backup_bytes = fs::read(&backup_path).unwrap();
        let backup_time = fs::metadata(&backup_path).unwrap().modified().unwrap();
        for _ in 0..2 {
            let again = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
            assert_eq!(again.doc, second.doc);
            assert_eq!(fs::read(&backup_path).unwrap(), backup_bytes);
            assert_eq!(
                fs::metadata(&backup_path).unwrap().modified().unwrap(),
                backup_time
            );
        }
        assert_ne!(old, second.doc);
    }

    #[test]
    fn stale_successful_export_does_not_resurrect_a_deleted_manual_entry() {
        let runtime = tempfile::tempdir().unwrap();
        let repo = runtime.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let first = with_doc_at(runtime.path(), |doc| {
            doc.add_entry("dev", &repo.to_string_lossy(), Some("Repo"))
        }).unwrap();
        let path = runtime.path().join("launch-roots.txt");
        let previous = fs::read(&path).unwrap();
        assert_eq!(first.doc.export.roots_txt_digest, Some(roots_txt_digest(&previous)));

        let mut deleted = first.doc.clone();
        deleted.remove_entry(&first.doc.entries[0].id);
        // Simulate interruption after the source commit and before TXT export.
        save_json(runtime.path(), &deleted, true).unwrap();
        assert!(load(runtime.path()).unwrap().entries.is_empty());
        assert_eq!(fs::read(&path).unwrap(), previous);

        let recovered = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        assert!(recovered.doc.entries.is_empty());
        assert!(!recovered.external_imported);
        assert_eq!(recovered.doc.export.last_external_merge_at, None);
        let current = fs::read(&path).unwrap();
        assert_ne!(current, previous);
        assert_eq!(current, super::super::export::render_roots_txt(&recovered.doc).as_bytes());
        assert_eq!(recovered.doc.export.roots_txt_digest, Some(roots_txt_digest(&current)));
        assert_eq!(load(runtime.path()).unwrap(), recovered.doc);
        let again = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        assert_eq!(again.doc, recovered.doc);
        assert!(!again.external_imported);
    }

    #[test]
    fn sync_uses_content_even_with_equal_or_older_mtime_and_records_import_once() {
        use super::super::model::LauncherDirEntry;

        let runtime = tempfile::tempdir().unwrap();
        let first = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        let path = runtime.path().join("launch-roots.txt");
        let stamp = first.doc.export.roots_txt_mtime_ms.unwrap();
        let written_at = first.doc.export.roots_txt_written_at.clone();
        for (index, external_stamp) in [stamp, stamp.saturating_sub(86_400_000)].into_iter().enumerate() {
            let before = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
            let mut external = before.doc.clone();
            external.entries.push(LauncherDirEntry::manual(
                "dev", &format!("External {index}"), &format!("C:/external{index}"),
            ));
            let bytes = super::super::export::render_roots_txt(&external).into_bytes();
            fs::write(&path, &bytes).unwrap();
            fs::OpenOptions::new().write(true).open(&path).unwrap()
                .set_modified(UNIX_EPOCH + std::time::Duration::from_millis(external_stamp)).unwrap();
            let actual_time = fs::metadata(&path).unwrap().modified().unwrap();
            let imported = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
            assert!(imported.external_imported);
            assert_eq!(imported.doc.entries.len(), index + 1);
            assert!(imported.doc.export.last_external_merge_at.is_some());
            assert_eq!(imported.doc.export.roots_txt_mtime_ms, roots_mtime_ms(&path));
            assert_eq!(imported.doc.export.roots_txt_written_at, written_at);
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), actual_time);
            let again = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
            assert!(!again.external_imported);
            assert_eq!(again.doc, imported.doc);
        }
        let before = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        fs::OpenOptions::new().write(true).open(&path).unwrap()
            .set_modified(UNIX_EPOCH + std::time::Duration::from_millis(stamp + 10_000)).unwrap();
        let actual_time = fs::metadata(&path).unwrap().modified().unwrap();
        let same = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        assert!(!same.external_imported);
        assert_eq!(same.doc.entries, before.doc.entries);
        assert_eq!(same.doc.export.last_external_merge_at, before.doc.export.last_external_merge_at);
        assert_eq!(same.doc.export.roots_txt_mtime_ms, roots_mtime_ms(&path));
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), actual_time);
    }

    #[test]
    fn missing_txt_is_reexported_and_unreadable_bytes_are_preserved_before_export() {
        for existing_json in [false, true] {
            let runtime = tempfile::tempdir().unwrap();
            let path = runtime.path().join("launch-roots.txt");
            if existing_json {
                with_doc_at(runtime.path(), |_| Ok(())).unwrap();
                fs::rename(&path, runtime.path().join("removed-roots.txt")).unwrap();
                let missing = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
                assert!(!missing.external_imported);
                assert!(path.is_file());
            }
            let invalid = b"\xff\xfeU\0n\0r\0e\0a\0d\0";
            fs::write(&path, invalid).unwrap();
            let view = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
            assert!(!view.external_imported);
            assert!(view.doc.export.last_external_merge_at.is_none());
            assert_eq!(fs::read_to_string(&path).unwrap(), super::super::export::render_roots_txt(&view.doc));
            let backups: Vec<_> = fs::read_dir(runtime.path()).unwrap()
                .map(Result::unwrap)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("launch-roots.txt.unreadable-"))
                .collect();
            assert_eq!(backups.len(), 1);
            assert_eq!(fs::read(backups[0].path()).unwrap(), invalid);
            assert!(!with_doc_at(runtime.path(), |_| Ok(())).unwrap().external_imported);
        }
    }

    #[test]
    fn a_second_external_edit_after_import_survives_the_following_persist() {
        let runtime = tempfile::tempdir().unwrap();
        let first = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        let path = runtime.path().join("launch-roots.txt");
        fs::write(&path, "First|C:/first\n").unwrap();
        let raced = with_doc_at(runtime.path(), |doc| {
            doc.set_section_label("dev", "Repos")?;
            fs::write(&path, "Second|C:/second\n").map_err(|e| e.to_string())
        }).unwrap();
        assert!(raced.external_imported);
        assert_eq!(raced.doc.entries.len(), 1);
        assert_eq!(raced.doc.entries[0].label, "First");
        assert_eq!(fs::read_to_string(&path).unwrap(), "Second|C:/second\n");
        assert_eq!(raced.doc.export.roots_txt_mtime_ms, first.doc.export.roots_txt_mtime_ms);
        assert_eq!(raced.doc.export.roots_txt_written_at, first.doc.export.roots_txt_written_at);
        assert_eq!(raced.doc.export.roots_txt_digest, first.doc.export.roots_txt_digest);
        let next = with_doc_at(runtime.path(), |_| Ok(())).unwrap();
        assert!(next.external_imported);
        assert_eq!(next.doc.entries.len(), 2);
        assert_eq!(next.doc.sections[0].label, "Repos");
        assert!(!with_doc_at(runtime.path(), |_| Ok(())).unwrap().external_imported);
    }

    #[test]
    fn corrupt_json_is_preserved_and_recovers_from_txt_without_a_usable_backup() {
        // Invalid UTF-8 is corrupt JSON too, not an ordinary file I/O error.
        for contents in [b"{broken".as_slice(), b"\xff\xfe".as_slice()] {
            for backup in [None, Some(b"invalid backup".as_slice())] {
                let runtime = tempfile::tempdir().unwrap();
                fs::write(runtime.path().join("launch-dirs.json"), contents).unwrap();
                if let Some(backup) = backup {
                    fs::write(runtime.path().join("launch-dirs.json.bak"), backup).unwrap();
                }
                fs::write(
                    runtime.path().join("launch-roots.txt"),
                    "Recovered|C:/recovered\n",
                )
                .unwrap();
                let doc = with_doc_at(runtime.path(), |_| Ok(())).unwrap().doc;
                assert_eq!(doc.entries.len(), 1);
                assert_eq!(doc.entries[0].label, "Recovered");
                assert_eq!(doc.entries[0].path, "C:/recovered");
                assert_eq!(doc.entries[0].source, Source::Manual);
                let corrupt = fs::read_dir(runtime.path())
                    .unwrap()
                    .filter_map(Result::ok)
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with("launch-dirs.json.corrupt-")
                    })
                    .unwrap();
                assert_eq!(fs::read(corrupt.path()).unwrap(), contents);
                assert!(serde_json::from_str::<LauncherDirsDoc>(
                    &fs::read_to_string(runtime.path().join("launch-dirs.json")).unwrap()
                )
                .is_ok());
            }
        }
    }

    #[test]
    fn corrupt_json_prefers_the_backup_and_preserves_its_bytes() {
        let runtime = tempfile::tempdir().unwrap();
        let mut backup = LauncherDirsDoc::default();
        backup
            .entries
            .push(super::super::model::LauncherDirEntry::manual(
                "dev",
                "Backup",
                "C:/backup",
            ));
        backup.sections[0].label = "Recovered section".to_string();
        backup.ignored_paths.push("C:/ignored".to_string());
        backup.rules = vec![serde_json::json!({"root":"C:/future", "custom":true})];
        backup.last_scan = Some(serde_json::json!({"future":42}));
        let backup_bytes = serde_json::to_vec_pretty(&backup).unwrap();
        let backup_path = runtime.path().join("launch-dirs.json.bak");
        fs::write(&backup_path, &backup_bytes).unwrap();
        fs::write(runtime.path().join("launch-dirs.json"), b"{broken").unwrap();
        fs::write(
            runtime.path().join("launch-roots.txt"),
            "Do not import|C:/other\n",
        )
        .unwrap();
        let recovered = with_doc_at(runtime.path(), |_| Ok(())).unwrap().doc;
        assert_eq!(recovered.entries, backup.entries);
        assert_eq!(recovered.sections, backup.sections);
        assert_eq!(recovered.ignored_paths, backup.ignored_paths);
        assert_eq!(recovered.rules, backup.rules);
        assert_eq!(recovered.last_scan, backup.last_scan);
        assert_eq!(recovered.export.last_external_merge_at, None);
        assert_eq!(fs::read(&backup_path).unwrap(), backup_bytes);
    }

    #[test]
    fn corrupt_json_uses_defaults_when_neither_recovery_source_is_usable() {
        let runtime = tempfile::tempdir().unwrap();
        fs::write(runtime.path().join("launch-dirs.json"), b"{broken").unwrap();
        fs::write(runtime.path().join("launch-dirs.json.bak"), b"\xff\xfe").unwrap();
        let recovered = load(runtime.path()).unwrap();
        assert_eq!(recovered.sections, LauncherDirsDoc::default().sections);
        assert!(recovered.entries.is_empty());
        assert!(runtime.path().join("launch-roots.txt").is_file());
    }

    #[test]
    fn mru_prepends_normalizes_deduplicates_and_caps_at_eight() {
        let runtime = tempfile::tempdir().unwrap();
        let file = runtime.path().join("launch-dirs-mru.txt");
        let duplicate = if cfg!(windows) { "/c/a/" } else { "C:/a/" };
        fs::write(
            &file,
            format!("\nC:/a\n{duplicate}\nC:/b\nC:/c\nC:/d\nC:/e\nC:/f\nC:/g\nC:/h\nC:/i\n"),
        )
        .unwrap();
        let recent = if cfg!(windows) { "/c/b/" } else { "C:/b/" };
        record_dir_mru(runtime.path(), recent).unwrap();
        let paths = parse_mru(&fs::read_to_string(&file).unwrap());
        assert_eq!(
            paths,
            vec!["C:/b", "C:/a", "C:/c", "C:/d", "C:/e", "C:/f", "C:/g", "C:/h"]
        );
        record_dir_mru(runtime.path(), "C:\\new\\").unwrap();
        let paths = parse_mru(&fs::read_to_string(file).unwrap());
        assert_eq!(paths[0], "C:/new");
        assert_eq!(paths.len(), 8);
        assert!(!fs::read_dir(runtime.path()).unwrap().any(|entry| {
            entry.unwrap().file_name().to_string_lossy().starts_with("launch-dirs-mru.txt.tmp")
        }));
    }
}
