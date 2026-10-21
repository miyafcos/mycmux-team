//! Preserve a single rollback copy before any v3 schema or data writes.
use std::path::{Path, PathBuf};
use rusqlite::{Connection, DatabaseName, Transaction, TransactionBehavior};

pub(super) fn before_v3(conn: &Connection, path: &Path) -> Result<Option<PathBuf>, String> {
    let version: i64 = conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM index_state WHERE key='schema_ext_version'", [],
        |r| r.get(0)).unwrap_or(0);
    let historical: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM turn)", [],
        |r| r.get(0)).unwrap_or(false);
    if version >= 3 || !historical { return Ok(None); }
    let parent = path.parent().ok_or("database has no parent")?;
    let prefix = format!("{}.pre-v3-", path.file_name().ok_or("database has no filename")?.to_string_lossy());
    let mut existing = std::fs::read_dir(parent).map_err(|e|e.to_string())?
        .filter_map(Result::ok).map(|e|e.path()).filter(|p|p.file_name().is_some_and(|n| {
            let n=n.to_string_lossy(); n.starts_with(&prefix) && n.ends_with(".bak")
        })).collect::<Vec<_>>();
    existing.sort();
    if let Some(backup)=existing.first() {
        let verify=Connection::open_with_flags(backup,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e|format!("existing pre-v3 backup unreadable: {e}"))?;
        let ok:String=verify.query_row("PRAGMA quick_check",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if ok!="ok" { return Err("existing pre-v3 backup is invalid; retained without overwriting".into()); }
        return Ok(Some(backup.clone()));
    }
    let backup=parent.join(format!("{prefix}{}.bak",chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ")));
    // Prevent another writer changing the source while selecting its snapshot.
    let tx=Transaction::new_unchecked(conn,TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let wal=PathBuf::from(format!("{}-wal",path.to_string_lossy()));
    if std::fs::metadata(&wal).map(|m|m.len()>32).unwrap_or(false) {
        // A WAL snapshot requires SQLite's online backup, not a base-file copy.
        let source=Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e|e.to_string())?;
        source.backup(DatabaseName::Main,&backup,None).map_err(|e|format!("pre-v3 WAL backup: {e}"))?;
    } else {
        // Preserve bytes (and thus the original SHA) for a checkpointed cache.
        use std::io::Write;
        let mut src=std::fs::File::open(path).map_err(|e|e.to_string())?;
        let mut dst=std::fs::OpenOptions::new().write(true).create_new(true).open(&backup).map_err(|e|e.to_string())?;
        std::io::copy(&mut src,&mut dst).map_err(|e|e.to_string())?;
        dst.flush().and_then(|_|dst.sync_all()).map_err(|e|e.to_string())?;
    }
    tx.rollback().map_err(|e|e.to_string())?;
    Ok(Some(backup))
}
