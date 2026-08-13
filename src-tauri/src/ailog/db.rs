//! Database lifecycle separation for the analytics cache.
//!
//! SQLite's immutable/read-only modes cannot safely recover a WAL database,
//! so readers use normal opens plus `query_only=ON`.  Initialization is kept
//! out of those reader opens: schema, additive migrations and legacy backfill
//! run once per database path in this process.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;

fn initialized_paths() -> &'static Mutex<HashSet<PathBuf>> {
    static PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn ensure_initialized(path: &Path) -> Result<(), String> {
    let normalized = path.to_path_buf();
    let mut paths = initialized_paths().lock().unwrap_or_else(|err| err.into_inner());
    if paths.contains(&normalized) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("create {parent:?}: {err}"))?;
    }
    let conn = Connection::open(path).map_err(|err| format!("open {path:?}: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(|err| format!("set busy timeout: {err}"))?;
    crate::ailog::schema::init(&conn)?;
    crate::ailog::migrate::apply(&conn)?;
    crate::ailog::backfill::internal_origin(&conn)?;
    paths.insert(normalized);
    Ok(())
}

pub fn reader(path: &Path) -> Result<Connection, String> {
    ensure_initialized(path)?;
    let conn = Connection::open(path).map_err(|err| format!("open reader {path:?}: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(|err| format!("set reader busy timeout: {err}"))?;
    conn.execute_batch("PRAGMA query_only=ON")
        .map_err(|err| format!("set query_only reader: {err}"))?;
    Ok(conn)
}

pub fn writer(path: &Path) -> Result<Connection, String> {
    ensure_initialized(path)?;
    let conn = Connection::open(path).map_err(|err| format!("open writer {path:?}: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(|err| format!("set writer busy timeout: {err}"))?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    #[test]
    fn readers_are_query_only_after_one_initialization() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ailog.db");
        super::ensure_initialized(&path).unwrap();
        super::ensure_initialized(&path).unwrap();
        let reader = super::reader(&path).unwrap();
        assert_eq!(reader.query_row("PRAGMA query_only", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
}
