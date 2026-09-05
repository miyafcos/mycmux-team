use std::{fs, io::ErrorKind, path::Path, sync::Mutex, time::UNIX_EPOCH};

use super::export::{roots_mtime_ms, write_roots_txt};
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

fn persist(runtime_dir: &Path, doc: &mut LauncherDirsDoc) -> Result<(), String> {
    // Commit the source before exporting it. A failed export cannot discard a
    // user's edit. Then persist the actual mtime without rotating the backup
    // a second time, so .bak still holds the previous document revision.
    save_json(runtime_dir, doc, true)?;
    write_roots_txt(runtime_dir, doc)?;
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
                Err(error) if error.kind() == ErrorKind::NotFound => fresh_doc(),
                Err(error) => return Err(error.to_string()),
            }
        }
        Err(error) => return Err(error.to_string()),
    };
    backup_roots(runtime_dir)?;
    persist(runtime_dir, &mut doc)?;
    Ok(doc)
}

fn sync_external(runtime_dir: &Path, doc: &mut LauncherDirsDoc) -> Result<bool, String> {
    let path = runtime_dir.join("launch-roots.txt");
    match fs::metadata(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            persist(runtime_dir, doc)?;
            return Ok(false);
        }
        Err(_) => return Ok(false),
        Ok(_) => {}
    }
    let Some(mtime) = roots_mtime_ms(&path) else {
        return Ok(false);
    };
    if doc
        .export
        .roots_txt_mtime_ms
        .is_some_and(|previous| mtime <= previous)
    {
        return Ok(false);
    }
    let Ok(contents) = fs::read_to_string(&path) else {
        return Ok(false);
    };
    let changed = merge_external(doc, &parse_roots_txt(&contents));
    doc.export.last_external_merge_at = Some(now());
    persist(runtime_dir, doc)?;
    Ok(changed)
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
    sync_external(runtime_dir, &mut doc)?;
    f(&mut doc)?;
    super::scan::prune_candidates(&mut doc);
    persist(runtime_dir, &mut doc)?;
    Ok(LauncherDirsView::new(runtime_dir, doc))
}

pub fn record_dir_mru(runtime_dir: &Path, path: &str) -> Result<(), String> {
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
    let tmp = runtime_dir.join("launch-dirs-mru.txt.tmp");
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
    fn sync_uses_strict_milliseconds_and_records_external_import() {
        let runtime = tempfile::tempdir().unwrap();
        let mut doc = load(runtime.path()).unwrap();
        let path = runtime.path().join("launch-roots.txt");
        let stamp = doc.export.roots_txt_mtime_ms.unwrap();
        let written_at = doc.export.roots_txt_written_at.clone();
        let mut external = doc.clone();
        external
            .entries
            .push(super::super::model::LauncherDirEntry::manual(
                "dev",
                "External",
                "C:/external",
            ));
        fs::write(&path, super::super::export::render_roots_txt(&external)).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(UNIX_EPOCH + std::time::Duration::from_millis(stamp))
            .unwrap();
        assert!(!sync_external(runtime.path(), &mut doc).unwrap());
        assert!(doc.entries.is_empty());
        file.set_modified(UNIX_EPOCH + std::time::Duration::from_millis(stamp + 1))
            .unwrap();
        assert!(sync_external(runtime.path(), &mut doc).unwrap());
        assert_eq!(doc.entries[0].label, "External");
        assert!(doc.export.last_external_merge_at.is_some());
        assert_eq!(doc.export.roots_txt_mtime_ms, Some(stamp + 1));
        assert_eq!(roots_mtime_ms(&path), Some(stamp + 1));
        assert_eq!(doc.export.roots_txt_written_at, written_at);
        let merged = doc.clone();
        assert!(!sync_external(runtime.path(), &mut doc).unwrap());
        assert_eq!(doc, merged);
        doc.export.roots_txt_mtime_ms = None;
        fs::write(&path, "Other|C:/other\n").unwrap();
        assert!(sync_external(runtime.path(), &mut doc).unwrap());
        assert_eq!(doc.entries.len(), 2);
    }

    #[test]
    fn missing_txt_is_reexported_and_unreadable_external_txt_is_not_merged() {
        let runtime = tempfile::tempdir().unwrap();
        let mut doc = load(runtime.path()).unwrap();
        let path = runtime.path().join("launch-roots.txt");
        fs::rename(&path, runtime.path().join("removed-roots.txt")).unwrap();
        assert!(!sync_external(runtime.path(), &mut doc).unwrap());
        assert!(path.is_file());
        fs::write(&path, [0xff, 0xfe]).unwrap();
        doc.export.roots_txt_mtime_ms = None;
        assert!(!sync_external(runtime.path(), &mut doc).unwrap());
        assert!(doc.export.last_external_merge_at.is_none());
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
        fs::write(
            &file,
            "\nC:/a\n/c/a/\nC:/b\nC:/c\nC:/d\nC:/e\nC:/f\nC:/g\nC:/h\nC:/i\n",
        )
        .unwrap();
        record_dir_mru(runtime.path(), "/c/b/").unwrap();
        let paths = parse_mru(&fs::read_to_string(&file).unwrap());
        assert_eq!(
            paths,
            vec!["C:/b", "C:/a", "C:/c", "C:/d", "C:/e", "C:/f", "C:/g", "C:/h"]
        );
        record_dir_mru(runtime.path(), "C:\\new\\").unwrap();
        let paths = parse_mru(&fs::read_to_string(file).unwrap());
        assert_eq!(paths[0], "C:/new");
        assert_eq!(paths.len(), 8);
        assert!(!runtime.path().join("launch-dirs-mru.txt.tmp").exists());
    }
}
