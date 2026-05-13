use crate::usage::UsageEvent;
use glob::glob;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

type EventParser = fn(&Value) -> Option<UsageEvent>;

#[derive(Clone, Debug)]
struct CachedFile {
    mtime: SystemTime,
    size: u64,
    last_offset: u64,
    events: Vec<UsageEvent>,
}

static USAGE_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedFile>>> = OnceLock::new();

pub fn read_events(pattern: &str, parser: EventParser) -> Result<Vec<UsageEvent>, String> {
    let mut events = Vec::new();
    let paths = glob(pattern).map_err(|err| format!("Invalid usage glob pattern: {err}"))?;

    for entry in paths {
        let path = match entry {
            Ok(path) => path,
            Err(err) => {
                eprintln!("[usage] failed to read glob entry: {err}");
                continue;
            }
        };
        events.extend(read_file_events(&path, parser)?);
    }

    Ok(events)
}

fn read_file_events(path: &Path, parser: EventParser) -> Result<Vec<UsageEvent>, String> {
    let key = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let metadata = std::fs::metadata(path).map_err(|err| {
        format!(
            "Failed to read usage file metadata {}: {err}",
            path.display()
        )
    })?;
    let size = metadata.len();
    let mtime = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);

    let cache = USAGE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let (start_offset, mut events) = {
        let guard = cache
            .lock()
            .map_err(|_| "Usage cache lock poisoned".to_string())?;
        if let Some(cached) = guard.get(&key) {
            if size == cached.size && mtime == cached.mtime {
                return Ok(cached.events.clone());
            }

            if size > cached.last_offset && mtime >= cached.mtime {
                (cached.last_offset, cached.events.clone())
            } else {
                (0, Vec::new())
            }
        } else {
            (0, Vec::new())
        }
    };

    let mut file = File::open(path)
        .map_err(|err| format!("Failed to open usage file {}: {err}", path.display()))?;
    file.seek(SeekFrom::Start(start_offset))
        .map_err(|err| format!("Failed to seek usage file {}: {err}", path.display()))?;

    let mut appended = String::new();
    file.read_to_string(&mut appended)
        .map_err(|err| format!("Failed to read usage file {}: {err}", path.display()))?;

    for line in appended.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(event) = parser(&value) {
            events.push(event);
        }
    }

    let mut guard = cache
        .lock()
        .map_err(|_| "Usage cache lock poisoned".to_string())?;
    guard.insert(
        key,
        CachedFile {
            mtime,
            size,
            last_offset: size,
            events: events.clone(),
        },
    );

    Ok(events)
}

#[cfg(test)]
pub fn reset_cache() {
    if let Some(cache) = USAGE_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            guard.clear();
        }
    }
}
