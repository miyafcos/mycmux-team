//! Wait for WebKit's actual SQLite values, without writing its database or
//! moving the existing preferences. Only macOS calls the exit barrier.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Debug, PartialEq)]
struct Pending {
    version: u32,
    fields: BTreeMap<String, Option<Value>>,
}

#[derive(Default)]
pub struct PreferenceWrites(Mutex<BTreeMap<String, Pending>>);

impl PreferenceWrites {
    fn note(
        &self,
        name: String,
        patch: Map<String, Value>,
        removed: Vec<String>,
        version: u32,
    ) -> Result<(), String> {
        if name != "mycmux-settings" && name != "mycmux-account-auto-switch" {
            return Err("Unknown preference store".into());
        }
        let mut writes = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let entry = writes.entry(name).or_insert_with(|| Pending {
            version,
            fields: BTreeMap::new(),
        });
        entry.version = version;
        for (key, value) in patch {
            entry.fields.insert(key, Some(value));
        }
        for key in removed {
            entry.fields.insert(key, None);
        }
        Ok(())
    }

    fn snapshot(&self) -> BTreeMap<String, Pending> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn acknowledge(&self, expected: &BTreeMap<String, Pending>) {
        let mut writes = self.0.lock().unwrap_or_else(|error| error.into_inner());
        for (name, entry) in expected {
            if writes.get(name) == Some(entry) {
                writes.remove(name);
            }
        }
    }
}

/// The frontend reports just its changed fields, after the existing M7 write.
/// This is an in-memory receipt, never a second preferences writer.
#[tauri::command(async)]
pub async fn note_preference_write(
    state: State<'_, PreferenceWrites>,
    name: String,
    patch: Map<String, Value>,
    removed: Vec<String>,
    version: u32,
) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        state.note(name, patch, removed, version)?;
    }
    Ok(())
}

fn decode_value(value: rusqlite::types::Value) -> Result<Value, String> {
    let raw = match value {
        rusqlite::types::Value::Text(text) => text,
        rusqlite::types::Value::Blob(bytes) => {
            if bytes.len() % 2 != 0 {
                return Err("Invalid WebKit UTF-16 value".into());
            }
            let words: Vec<_> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16(&words).map_err(|error| error.to_string())?
        }
        _ => return Err("Invalid WebKit preference value".into()),
    };
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn matches(value: &Value, wanted: &Pending) -> bool {
    if value.get("version").and_then(Value::as_u64) != Some(u64::from(wanted.version)) {
        return false;
    }
    let Some(state) = value.get("state").and_then(Value::as_object) else {
        return false;
    };
    wanted.fields.iter().all(|(key, expected)| match expected {
        Some(expected) => state.get(key) == Some(expected),
        None => !state.contains_key(key),
    })
}

fn sync_committed_files(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        // A committed SQLite row may reside in the WAL. Sync both files before
        // acknowledging, including the directory if WebKit just created it.
        let mut files = vec![path.to_path_buf()];
        for suffix in ["-wal", "-journal"] {
            let Some(name) = path.file_name() else {
                return false;
            };
            files.push(path.with_file_name(format!("{}{suffix}", name.to_string_lossy())));
        }
        for (index, file) in files.into_iter().enumerate() {
            match std::fs::File::open(file) {
                Ok(file) => {
                    if file.sync_all().is_err() {
                        return false;
                    }
                }
                Err(error) if index > 0 && error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return false,
            }
        }
        let Some(parent) = path.parent() else {
            return false;
        };
        return std::fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .is_ok();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        true
    }
}

fn disk_matches(
    paths: &[PathBuf],
    expected: &BTreeMap<String, Pending>,
    deadline: Instant,
) -> bool {
    let mut remaining = expected.clone();
    for path in paths {
        if Instant::now() >= deadline {
            return false;
        }
        let Ok(db) = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else {
            continue;
        };
        let _ = db.busy_timeout(Duration::from_millis(20));
        let mut matched = Vec::new();
        for (name, wanted) in &remaining {
            let raw = db
                .query_row(
                    "SELECT value FROM ItemTable WHERE key = ?1",
                    [name],
                    |row| row.get::<_, rusqlite::types::Value>(0),
                )
                .optional();
            let Ok(Some(raw)) = raw else {
                continue;
            };
            let Ok(value) = decode_value(raw) else {
                continue;
            };
            if matches(&value, wanted) {
                matched.push(name.clone());
            }
        }
        if !matched.is_empty() && sync_committed_files(path) {
            for name in matched {
                remaining.remove(&name);
            }
        }
        if remaining.is_empty() {
            return true;
        }
    }
    false
}

fn databases(root: &Path, deadline: Instant) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        if Instant::now() >= deadline {
            break;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if Instant::now() >= deadline {
                break;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // Do not follow symlinks out of this application's WebsiteData.
            if kind.is_dir() && depth < 12 {
                pending.push((entry.path(), depth + 1));
            } else if kind.is_file() && entry.file_name() == "localstorage.sqlite3" {
                found.push(entry.path());
            }
        }
    }
    found
}

fn wait_for_disk(writes: &PreferenceWrites, root: &Path, deadline: Instant) -> bool {
    loop {
        let expected = writes.snapshot();
        if expected.is_empty() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        if disk_matches(&databases(root, deadline), &expected, deadline) {
            writes.acknowledge(&expected);
            if writes.snapshot().is_empty() {
                return true;
            }
        }
        std::thread::sleep(
            Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

/// Called first by the existing shutdown worker. The native event-loop callback
/// retains its existing three-second deadline even if filesystem I/O wedges.
#[cfg(target_os = "macos")]
pub fn flush_at_exit(app: &AppHandle, deadline: Instant) {
    let Some(writes) = app.try_state::<PreferenceWrites>() else {
        return;
    };
    if writes.snapshot().is_empty() {
        return;
    }
    let started = Instant::now();
    let Some(home) = dirs::home_dir() else {
        crate::diag_warn!("settings-flush", "home directory unavailable");
        return;
    };
    let root = home
        .join("Library/WebKit")
        .join(&app.config().identifier)
        .join("WebsiteData");
    // Leave time for the workspace/PTY cleanup within the unchanged budget.
    let deadline = deadline.min(started + Duration::from_secs(2));
    let flushed = wait_for_disk(&writes, &root, deadline);
    crate::diag::log(&format!(
        "[settings-flush] disk_confirmed={flushed} elapsed_ms={}",
        started.elapsed().as_millis()
    ));
    if !flushed {
        crate::diag_warn!(
            "settings-flush",
            "WebKit preferences did not reach disk before the bounded exit deadline"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(target_os = "macos")]
    #[test]
    fn a_missing_primary_file_cannot_be_acknowledged_as_durable() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!sync_committed_files(&dir.path().join("localstorage.sqlite3")));
    }

    fn pending(fields: Value) -> Pending {
        Pending {
            version: 7,
            fields: fields
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), Some(value.clone())))
                .collect(),
        }
    }

    fn save(path: &Path, name: &str, value: &Value) {
        let db = Connection::open(path).unwrap();
        db.execute_batch("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE, value BLOB)")
            .unwrap();
        let bytes: Vec<_> = value
            .to_string()
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        db.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params![name, bytes],
        )
        .unwrap();
    }

    #[test]
    fn validates_real_webkit_utf16_and_preserves_unrelated_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("localstorage.sqlite3");
        let value = json!({"version":7,"state":{"native":false,"foreign":["kept"]}});
        save(&path, "mycmux-settings", &value);
        let wanted = BTreeMap::from([("mycmux-settings".into(), pending(json!({"native":false})))]);
        assert!(disk_matches(
            &[path.clone()],
            &wanted,
            Instant::now() + Duration::from_secs(1)
        ));
        let db = Connection::open(&path).unwrap();
        let raw = db
            .query_row("SELECT value FROM ItemTable", [], |row| row.get(0))
            .unwrap();
        assert_eq!(decode_value(raw).unwrap(), value);
    }

    #[test]
    fn waits_for_the_actual_delayed_commit_and_then_acknowledges() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("localstorage.sqlite3");
        save(
            &path,
            "mycmux-settings",
            &json!({"version":7,"state":{"native":true}}),
        );
        let writes = PreferenceWrites::default();
        writes
            .note(
                "mycmux-settings".into(),
                json!({"native":false}).as_object().unwrap().clone(),
                vec![],
                7,
            )
            .unwrap();
        let changed = path.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            save(
                &changed,
                "mycmux-settings",
                &json!({"version":7,"state":{"native":false}}),
            );
        });
        let start = Instant::now();
        assert!(wait_for_disk(
            &writes,
            dir.path(),
            start + Duration::from_secs(2)
        ));
        assert!(start.elapsed() >= Duration::from_millis(60));
        worker.join().unwrap();
        assert!(writes.snapshot().is_empty());
    }

    #[test]
    fn a_stalled_storage_commit_obeys_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("localstorage.sqlite3");
        save(
            &path,
            "mycmux-settings",
            &json!({"version":7,"state":{"native":true}}),
        );
        let writes = PreferenceWrites::default();
        writes
            .note(
                "mycmux-settings".into(),
                json!({"native":false}).as_object().unwrap().clone(),
                vec![],
                7,
            )
            .unwrap();
        let start = Instant::now();
        assert!(!wait_for_disk(
            &writes,
            dir.path(),
            start + Duration::from_millis(100)
        ));
        assert!(start.elapsed() < Duration::from_millis(500));
        assert!(!writes.snapshot().is_empty());
    }

    #[test]
    fn acknowledgements_do_not_drop_edits_arriving_during_the_wait() {
        let writes = PreferenceWrites::default();
        writes
            .note(
                "mycmux-settings".into(),
                json!({"native":false}).as_object().unwrap().clone(),
                vec![],
                7,
            )
            .unwrap();
        let first = writes.snapshot();
        writes
            .note(
                "mycmux-settings".into(),
                json!({"other":true}).as_object().unwrap().clone(),
                vec![],
                7,
            )
            .unwrap();
        writes.acknowledge(&first);
        assert_eq!(writes.snapshot()["mycmux-settings"].fields.len(), 2);
    }

    #[test]
    fn stale_windows_can_only_add_the_fields_they_changed() {
        let writes = PreferenceWrites::default();
        writes
            .note(
                "mycmux-settings".into(),
                json!({"native":false}).as_object().unwrap().clone(),
                vec![],
                7,
            )
            .unwrap();
        writes
            .note(
                "mycmux-settings".into(),
                json!({"ai":true}).as_object().unwrap().clone(),
                vec![],
                7,
            )
            .unwrap();
        assert!(matches(
            &json!({"version":7,"state":{"native":false,"ai":true}}),
            &writes.snapshot()["mycmux-settings"]
        ));
        assert!(!matches(
            &json!({"version":7,"state":{"native":true,"ai":true}}),
            &writes.snapshot()["mycmux-settings"]
        ));
    }

    #[test]
    fn versions_and_deletions_are_part_of_the_disk_barrier() {
        let wanted = Pending {
            version: 7,
            fields: BTreeMap::from([("removed".into(), None)]),
        };
        assert!(!matches(&json!({"version":6,"state":{}}), &wanted));
        assert!(!matches(
            &json!({"version":7,"state":{"removed":1}}),
            &wanted
        ));
        assert!(matches(&json!({"version":7,"state":{}}), &wanted));
    }

    #[test]
    fn missing_or_corrupt_database_never_counts_as_flushed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("localstorage.sqlite3"), b"not SQLite").unwrap();
        let writes = PreferenceWrites::default();
        assert!(writes
            .note("unknown".into(), Map::new(), vec![], 7)
            .is_err());
        writes
            .note(
                "mycmux-settings".into(),
                json!({"native":false}).as_object().unwrap().clone(),
                vec![],
                7,
            )
            .unwrap();
        assert!(!wait_for_disk(
            &writes,
            dir.path(),
            Instant::now() + Duration::from_millis(60)
        ));
        let empty = PreferenceWrites::default();
        assert!(wait_for_disk(&empty, dir.path(), Instant::now()));
    }
}
