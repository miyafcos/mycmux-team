use crate::models::SessionEntry;
use crate::path_norm::crsm_dir;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

// Bumped to 7 when headless/exec sessions became non-human: cached entries keep
// the has_user_messages verdict computed by the scanner that wrote them, and
// unchanged transcripts are never rescanned. Without this bump the new filter
// would only apply to sessions written after the upgrade.
pub const CACHE_SCHEMA_VERSION: u16 = 7;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FileStamp {
    pub mtime_ms: i64,
    pub len: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CacheFile {
    pub schema_version: u16,
    pub generated_at: DateTime<Utc>,
    pub file_stamps: HashMap<String, FileStamp>,
    pub entries: Vec<SessionEntry>,
}

pub struct CacheLookup {
    file_stamps: HashMap<String, FileStamp>,
    by_path: HashMap<String, Vec<SessionEntry>>,
}

pub fn cache_path(home: &Path) -> PathBuf {
    crsm_dir(home).join("cache").join("sessions.json")
}

pub fn file_stamp(path: &Path) -> Option<FileStamp> {
    let metadata = path.metadata().ok()?;
    let modified: DateTime<Utc> = metadata.modified().ok()?.into();
    Some(FileStamp {
        mtime_ms: modified.timestamp_millis(),
        len: metadata.len(),
    })
}

pub fn stamp_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn load_cache(home: &Path) -> Option<CacheFile> {
    let path = cache_path(home);
    let contents = fs::read_to_string(path).ok()?;
    let cache: CacheFile = serde_json::from_str(&contents).ok()?;
    if cache.schema_version != CACHE_SCHEMA_VERSION {
        return None;
    }
    Some(cache)
}

pub fn save_cache(home: &Path, cache: &CacheFile) -> Result<(), String> {
    let path = cache_path(home);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create cache dir: {error}"))?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let json =
        serde_json::to_string_pretty(cache).map_err(|error| format!("serialize cache: {error}"))?;
    fs::write(&tmp_path, json).map_err(|error| format!("write cache tmp: {error}"))?;
    fs::rename(&tmp_path, &path).map_err(|error| format!("replace cache: {error}"))
}

impl CacheFile {
    pub fn empty() -> Self {
        Self {
            schema_version: CACHE_SCHEMA_VERSION,
            generated_at: Utc::now(),
            file_stamps: HashMap::new(),
            entries: Vec::new(),
        }
    }

    pub fn lookup(&self) -> CacheLookup {
        let mut by_path: HashMap<String, Vec<SessionEntry>> = HashMap::new();
        for entry in &self.entries {
            by_path
                .entry(stamp_key(&entry.source_path))
                .or_default()
                .push(entry.clone());
        }
        CacheLookup {
            file_stamps: self.file_stamps.clone(),
            by_path,
        }
    }
}

impl CacheLookup {
    pub fn unchanged(&self, path: &Path) -> bool {
        let Some(current) = file_stamp(path) else {
            return false;
        };
        self.file_stamps
            .get(&stamp_key(path))
            .map(|old| old.mtime_ms == current.mtime_ms && old.len == current.len)
            .unwrap_or(false)
    }

    pub fn entries_for_path(&self, path: &Path) -> Vec<SessionEntry> {
        let key = stamp_key(path);
        self.by_path.get(&key).cloned().unwrap_or_default()
    }

    pub fn entry_for_path(&self, path: &Path) -> Option<SessionEntry> {
        let key = stamp_key(path);
        self.by_path
            .get(&key)
            .and_then(|entries| entries.first())
            .cloned()
    }
}
