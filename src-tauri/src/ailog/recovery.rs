//! Preserve a single rollback copy before any v3 schema or data writes.
use std::path::{Path, PathBuf};
use rusqlite::{Connection, DatabaseName, Transaction, TransactionBehavior};

fn schema_ext_version(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM index_state WHERE key='schema_ext_version'", [],
        |r| r.get(0)).unwrap_or(0)
}

fn has_history(conn: &Connection) -> bool {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM turn)", [], |r| r.get(0)).unwrap_or(false)
}

/// A leftover file is reused only when it really is a pre-v3 copy with history.
/// An empty file opens as an empty database and passes quick_check, so the
/// size, page count, turn rows and schema version are all checked as well.
fn usable_backup(candidate: &Path) -> bool {
    if std::fs::metadata(candidate).map(|m| m.len() == 0).unwrap_or(true) { return false; }
    let Ok(verify) = Connection::open_with_flags(candidate, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return false; };
    let quick: Result<String, _> = verify.query_row("PRAGMA quick_check", [], |r| r.get(0));
    let pages: i64 = verify.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
    matches!(quick.as_deref(), Ok("ok")) && pages > 0 && has_history(&verify) && schema_ext_version(&verify) < 3
}

fn write_copy(path: &Path, partial: &Path, wal_snapshot: bool) -> Result<(), String> {
    if wal_snapshot {
        // A WAL snapshot requires SQLite's online backup, not a base-file copy.
        let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        source.backup(DatabaseName::Main, partial, None).map_err(|e| format!("pre-v3 WAL backup: {e}"))?;
        std::fs::OpenOptions::new().write(true).open(partial).and_then(|f| f.sync_all()).map_err(|e| e.to_string())
    } else {
        // Preserve bytes (and thus the original SHA) for a checkpointed cache.
        use std::io::Write;
        let mut src = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut dst = std::fs::OpenOptions::new().write(true).create_new(true).open(partial).map_err(|e| e.to_string())?;
        std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
        dst.flush().and_then(|_| dst.sync_all()).map_err(|e| e.to_string())
    }
}

pub(super) fn before_v3(conn: &Connection, path: &Path) -> Result<Option<PathBuf>, String> {
    if schema_ext_version(conn) >= 3 || !has_history(conn) { return Ok(None); }
    let parent = path.parent().ok_or("database has no parent")?;
    let prefix = format!("{}.pre-v3-", path.file_name().ok_or("database has no filename")?.to_string_lossy());
    let mut existing = std::fs::read_dir(parent).map_err(|e|e.to_string())?
        .filter_map(Result::ok).map(|e|e.path()).filter(|p|p.file_name().is_some_and(|n| {
            let n=n.to_string_lossy(); n.starts_with(&prefix) && n.ends_with(".bak")
        })).collect::<Vec<_>>();
    existing.sort();
    // Unusable leftovers are kept in place (never deleted) and a fresh copy is made.
    if let Some(backup) = existing.iter().find(|p| usable_backup(p)) {
        return Ok(Some(backup.clone()));
    }
    let backup=parent.join(format!("{prefix}{}.bak",chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ")));
    let partial=PathBuf::from(format!("{}.partial", backup.to_string_lossy()));
    // Prevent another writer changing the source while selecting its snapshot.
    let tx=Transaction::new_unchecked(conn,TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    // Another process may have migrated while this one waited for the write lock.
    if schema_ext_version(conn) >= 3 {
        tx.rollback().map_err(|e|e.to_string())?;
        return Ok(None);
    }
    let wal=PathBuf::from(format!("{}-wal",path.to_string_lossy()));
    let wal_snapshot=std::fs::metadata(&wal).map(|m|m.len()>32).unwrap_or(false);
    // Write under a temporary name and rename only after the copy is complete and
    // synced, so an interrupted or failed copy never looks like a finished backup.
    let written=write_copy(path,&partial,wal_snapshot).and_then(|_| std::fs::rename(&partial,&backup).map_err(|e|e.to_string()));
    if let Err(error)=written {
        let _ = std::fs::remove_file(&partial);
        let _ = tx.rollback();
        return Err(format!("pre-v3 backup failed; migration not started: {error}"));
    }
    tx.rollback().map_err(|e|e.to_string())?;
    Ok(Some(backup))
}
