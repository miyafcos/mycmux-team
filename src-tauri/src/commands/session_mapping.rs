use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Read pane-session mapping files written by launcher.sh
/// Returns a map of pane_session_id → claude_session_id
#[derive(Clone, serde::Serialize)]
pub struct AgentSessionMapping {
    pub agent_kind: Option<String>,
    pub session_id: String,
}

#[derive(Clone)]
struct SessionMappingCache {
    #[allow(dead_code)]
    pane_mappings: HashMap<String, String>,
    agent_mappings: HashMap<String, AgentSessionMapping>,
}

struct SessionMappingCacheEntry {
    refreshed_at: Instant,
    value: SessionMappingCache,
}

const SESSION_MAPPING_CACHE_TTL: Duration = Duration::from_secs(2);

fn session_mapping_cache() -> &'static Mutex<Option<SessionMappingCacheEntry>> {
    static CACHE: OnceLock<Mutex<Option<SessionMappingCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn invalidate_session_mapping_cache() {
    if let Ok(mut guard) = session_mapping_cache().lock() {
        *guard = None;
    }
}

pub(crate) fn is_agent_session_kind(value: &str) -> bool {
    matches!(value, "claude" | "codex" | "claude-codex")
}

fn parse_agent_session_mapping(contents: &str) -> Option<AgentSessionMapping> {
    let trimmed = contents.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some((kind, session_id)) = trimmed.split_once(':') {
        let kind = kind.trim();
        let session_id = session_id.trim();
        if is_agent_session_kind(kind) && !session_id.is_empty() {
            return Some(AgentSessionMapping {
                agent_kind: Some(kind.to_string()),
                session_id: session_id.to_string(),
            });
        }
    }

    Some(AgentSessionMapping {
        agent_kind: None,
        session_id: trimmed.to_string(),
    })
}

fn session_mapping_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".mycmux").join("pane-sessions"))
}

fn empty_session_mapping_cache() -> SessionMappingCache {
    SessionMappingCache {
        pane_mappings: HashMap::new(),
        agent_mappings: HashMap::new(),
    }
}

fn read_session_mapping_files(map_dir: &Path) -> SessionMappingCache {
    let mut pane_mappings = HashMap::new();
    let mut agent_mappings = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(map_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("txt") {
                continue;
            }
            let Some(pane_id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(contents) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Some(mapping) = parse_agent_session_mapping(&contents) else {
                continue;
            };
            pane_mappings.insert(pane_id.to_string(), mapping.session_id.clone());
            agent_mappings.insert(pane_id.to_string(), mapping);
        }
    }
    SessionMappingCache {
        pane_mappings,
        agent_mappings,
    }
}

fn load_session_mapping_cache_from_dir(
    map_dir: Option<&Path>,
    force_refresh: bool,
) -> SessionMappingCache {
    let now = Instant::now();
    if !force_refresh {
        if let Ok(guard) = session_mapping_cache().lock() {
            if let Some(entry) = guard.as_ref() {
                if now.duration_since(entry.refreshed_at) < SESSION_MAPPING_CACHE_TTL {
                    return entry.value.clone();
                }
            }
        }
    }

    let value = map_dir
        .map(read_session_mapping_files)
        .unwrap_or_else(empty_session_mapping_cache);
    if let Ok(mut guard) = session_mapping_cache().lock() {
        *guard = Some(SessionMappingCacheEntry {
            refreshed_at: now,
            value: value.clone(),
        });
    }
    value
}

fn load_session_mapping_cache(force_refresh: bool) -> SessionMappingCache {
    let map_dir = session_mapping_dir();
    load_session_mapping_cache_from_dir(map_dir.as_deref(), force_refresh)
}

fn unique_mapping_tmp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mapping.txt");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    path.with_file_name(format!(
        "{file_name}.tmp-{}-{timestamp}",
        std::process::id()
    ))
}

fn write_text_file_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create mapping dir {}: {error}", parent.display()))?;
    }
    let tmp_path = unique_mapping_tmp_path(path);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|error| format!("create mapping tmp {}: {error}", tmp_path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("write mapping tmp {}: {error}", tmp_path.display()))?;
    file.sync_all()
        .map_err(|error| format!("flush mapping tmp {}: {error}", tmp_path.display()))?;
    drop(file);
    std::fs::rename(&tmp_path, path)
        .inspect_err(|_error| {
            let _ = std::fs::remove_file(&tmp_path);
        })
        .map_err(|error| {
            format!(
                "replace mapping {} with {}: {error}",
                path.display(),
                tmp_path.display()
            )
        })
}

fn write_session_mapping_file_to_dir(
    map_dir: &Path,
    session_id: &str,
    agent_kind: &str,
    agent_session_id: &str,
) -> Result<(), String> {
    if session_id.trim().is_empty()
        || agent_kind.trim().is_empty()
        || agent_session_id.trim().is_empty()
        || !is_agent_session_kind(agent_kind)
    {
        return Ok(());
    }
    let path = map_dir.join(format!("{session_id}.txt"));
    write_text_file_atomic(&path, &format!("{agent_kind}:{agent_session_id}\n"))?;
    invalidate_session_mapping_cache();
    Ok(())
}

pub(crate) fn write_session_mapping_file(
    session_id: &str,
    agent_kind: &str,
    agent_session_id: &str,
) -> Result<(), String> {
    let Some(map_dir) = session_mapping_dir() else {
        return Ok(());
    };
    write_session_mapping_file_to_dir(&map_dir, session_id, agent_kind, agent_session_id)
}

#[tauri::command(async)]
pub fn read_agent_session_mappings() -> HashMap<String, AgentSessionMapping> {
    load_session_mapping_cache(true).agent_mappings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping_cache_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn parse_agent_session_mapping_with_kind() {
        let mapping = parse_agent_session_mapping("claude:abc-123\n").unwrap();
        assert_eq!(mapping.agent_kind.as_deref(), Some("claude"));
        assert_eq!(mapping.session_id, "abc-123");
    }

    #[test]
    fn parse_agent_session_mapping_with_bom_prefixed_kind() {
        let mapping = parse_agent_session_mapping("\u{feff}claude:abc-123\n").unwrap();
        assert_eq!(mapping.agent_kind.as_deref(), Some("claude"));
        assert_eq!(mapping.session_id, "abc-123");
    }

    #[test]
    fn parse_agent_session_mapping_without_kind() {
        let mapping = parse_agent_session_mapping("abc-123\n").unwrap();
        assert_eq!(mapping.agent_kind, None);
        assert_eq!(mapping.session_id, "abc-123");
    }

    #[test]
    fn load_session_mapping_cache_force_refresh_bypasses_ttl() {
        let _guard = mapping_cache_test_lock().lock().unwrap();
        invalidate_session_mapping_cache();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pane-1.txt");
        std::fs::write(&path, "codex:old-session\n").unwrap();

        let cached = load_session_mapping_cache_from_dir(Some(dir.path()), false);
        assert_eq!(
            cached
                .agent_mappings
                .get("pane-1")
                .map(|mapping| mapping.session_id.as_str()),
            Some("old-session")
        );

        std::fs::write(&path, "codex:new-session\n").unwrap();
        let stale = load_session_mapping_cache_from_dir(Some(dir.path()), false);
        assert_eq!(
            stale
                .agent_mappings
                .get("pane-1")
                .map(|mapping| mapping.session_id.as_str()),
            Some("old-session")
        );

        let fresh = load_session_mapping_cache_from_dir(Some(dir.path()), true);
        assert_eq!(
            fresh
                .agent_mappings
                .get("pane-1")
                .map(|mapping| mapping.session_id.as_str()),
            Some("new-session")
        );
        invalidate_session_mapping_cache();
    }

    #[test]
    fn write_session_mapping_file_to_dir_is_atomic_and_invalidates_cache() {
        let _guard = mapping_cache_test_lock().lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        if let Ok(mut guard) = session_mapping_cache().lock() {
            *guard = Some(SessionMappingCacheEntry {
                refreshed_at: Instant::now(),
                value: SessionMappingCache {
                    pane_mappings: HashMap::new(),
                    agent_mappings: HashMap::new(),
                },
            });
        }

        write_session_mapping_file_to_dir(dir.path(), "pane-1", "codex", "old-session").unwrap();
        write_session_mapping_file_to_dir(dir.path(), "pane-1", "codex", "new-session").unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("pane-1.txt")).unwrap(),
            "codex:new-session\n"
        );
        assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")
        }));
        assert!(session_mapping_cache().lock().unwrap().is_none());
    }
}
