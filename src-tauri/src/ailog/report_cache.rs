//! Restart-safe report snapshots in a small database beside the source index.
//! Reads never write the source connection. A snapshot retains its real range
//! and is explicitly marked until the renderer requests a fresh replacement.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{Filters, Range};

pub const FORMAT_VERSION: i64 = 1;
const MAX_ENTRIES: i64 = 128;
const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: i64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheMode {
    Prefer,
    Refresh,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub saved_at: i64,
    pub stale: bool,
}

pub trait Report: Serialize + DeserializeOwned {
    fn snapshot(&mut self) -> &mut Option<SnapshotInfo>;
}

/// The counter is transactional: failed indexing/repricing cannot invalidate
/// a committed snapshot, and even a partial successful index advances it.
/// Install once per source database initialization, never from a reader.
pub fn init_source_revision(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO index_state(key,value) VALUES ('report_revision','0')",
        [],
    )
    .map_err(|e| format!("init report revision: {e}"))?;
    conn.execute(
        "INSERT OR IGNORE INTO index_state(key,value) VALUES ('report_database_id',?1)",
        [uuid::Uuid::new_v4().to_string()],
    )
    .map_err(|e| format!("init report database identity: {e}"))?;
    for table in [
        "turn",
        "session",
        "source_file",
        "price",
        "rework",
        "tool_event",
        "file_touch",
        "summary",
    ] {
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            conn.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS report_revision_{table}_{operation} \
                 AFTER {operation} ON {table} BEGIN \
                 UPDATE index_state SET value=CAST(value AS INTEGER)+1 \
                 WHERE key='report_revision'; END;"
            ))
            .map_err(|e| format!("init report revision trigger: {e}"))?;
        }
    }
    Ok(())
}

fn code_signature() -> &'static [u8; 32] {
    static SIGNATURE: OnceLock<[u8; 32]> = OnceLock::new();
    SIGNATURE.get_or_init(|| {
        let mut hash = Sha256::new();
        hash.update(include_str!("price.rs"));
        hash.update(include_str!("query.rs"));
        hash.update(include_str!("usage.rs"));
        hash.finalize().into()
    })
}

fn fingerprint(conn: &Connection) -> Option<String> {
    let mut stmt = conn
        .prepare(
            // Per-file Codex parser cursors can be megabytes. They are not
            // report inputs: source_file/turn/session mutations already bump
            // report_revision transactionally. Two indexed ranges skip their
            // prefix while retaining every other derivation/price/rollup flag.
            "SELECT key,value FROM index_state WHERE key<'codex_ps:' \
             UNION ALL SELECT key,value FROM index_state WHERE key>='codex_ps;' \
             ORDER BY key",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if !rows.iter().any(|(key, _)| key == "report_database_id") {
        return None;
    }
    let mut hash = Sha256::new();
    // Source hashing also invalidates normalization/classification changes
    // without relying on a developer to remember a manual version bump.
    hash.update(code_signature());
    hash.update(serde_json::to_vec(&rows).ok()?);
    Some(format!("{:x}", hash.finalize()))
}

pub fn path(conn: &Connection) -> Option<PathBuf> {
    let source = conn.path().filter(|p| !p.is_empty())?;
    Some(Path::new(source).with_extension("reports.db"))
}

fn key(range: &Range, filters: &Filters, report: &str, axes: &[&str], now_ms: i64) -> String {
    let mut filters = filters.clone();
    filters.report_cache = None;
    for values in [
        &mut filters.kinds,
        &mut filters.models,
        &mut filters.projects,
        &mut filters.branches,
        &mut filters.efforts,
        &mut filters.origins,
    ] {
        values.sort();
        values.dedup();
    }
    let (_, label) = range.resolve(now_ms);
    // Relative presets are logical windows, not the last five-minute anchor.
    // Keep the saved bounds in the payload; never relabel old numbers as now.
    serde_json::json!({
        "report": report, "axes": axes, "filters": filters,
        "period": {"label": label, "from": range.from, "to": range.to,
                   "preset": range.preset},
    })
    .to_string()
}

fn open(path: &Path, write: bool) -> Result<Connection, rusqlite::Error> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let conn = Connection::open_with_flags(path, flags)?;
    // Cache failures/locks must not become a multi-second report dependency.
    conn.busy_timeout(Duration::from_millis(100))?;
    if write {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS report_snapshot (
               key TEXT PRIMARY KEY, version INTEGER NOT NULL,
               revision TEXT NOT NULL, saved_at INTEGER NOT NULL,
               range_from INTEGER NOT NULL, range_to INTEGER NOT NULL,
               payload TEXT NOT NULL
             );",
        )?;
    }
    Ok(conn)
}

fn load<T: Report>(
    path: &Path,
    key: &str,
    revision: Option<&str>,
    bounds: super::ResolvedRange,
) -> Option<T> {
    let conn = open(path, false).ok()?;
    let (stored_revision, saved_at, from, to, payload): (String, i64, i64, i64, String) = conn
        .query_row(
            "SELECT revision,saved_at,range_from,range_to,payload FROM report_snapshot \
             WHERE key=?1 AND version=?2 AND length(CAST(payload AS BLOB))<=?3",
            params![key, FORMAT_VERSION, MAX_PAYLOAD_BYTES as i64],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .ok()??;
    let mut report: T = serde_json::from_str(&payload).ok()?;
    *report.snapshot() = Some(SnapshotInfo {
        saved_at,
        stale: revision != Some(stored_revision.as_str()) || from != bounds.from || to != bounds.to,
    });
    Some(report)
}

fn save<T: Report>(
    path: &Path,
    key: &str,
    revision: &str,
    bounds: super::ResolvedRange,
    report: &T,
) -> Result<(), String> {
    let payload = serde_json::to_string(report).map_err(|e| e.to_string())?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Ok(());
    }
    let mut conn = open(path, true).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO report_snapshot VALUES (?1,?2,?3,?4,?5,?6,?7) \
         ON CONFLICT(key) DO UPDATE SET version=excluded.version,revision=excluded.revision,\
         saved_at=excluded.saved_at,range_from=excluded.range_from,range_to=excluded.range_to,\
         payload=excluded.payload \
         WHERE report_snapshot.version<>excluded.version OR \
         report_snapshot.range_to<=excluded.range_to",
        params![
            key,
            FORMAT_VERSION,
            revision,
            chrono::Utc::now().timestamp_millis(),
            bounds.from,
            bounds.to,
            payload
        ],
    )
    .map_err(|e| e.to_string())?;
    // Only derived snapshots are evicted; the source database is query-only.
    tx.execute(
        "DELETE FROM report_snapshot WHERE key IN \
         (SELECT key FROM report_snapshot ORDER BY saved_at DESC,rowid DESC LIMIT -1 OFFSET ?1)",
        [MAX_ENTRIES],
    )
    .map_err(|e| e.to_string())?;
    // Bound total payload as well as the number of period/axis combinations.
    tx.execute(
        "DELETE FROM report_snapshot WHERE key IN (SELECT key FROM (\
         SELECT key, SUM(length(CAST(payload AS BLOB))) OVER \
         (ORDER BY saved_at DESC,rowid DESC) AS bytes FROM report_snapshot) \
         WHERE bytes>?1)",
        [MAX_TOTAL_BYTES],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn report<T: Report>(
    conn: &Connection,
    range: &Range,
    filters: &Filters,
    name: &str,
    axes: &[&str],
    now_ms: i64,
    build: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let Some(mode) = filters.report_cache else {
        return build();
    };
    let Some(path) = path(conn) else {
        return build();
    };
    let cache_key = key(range, filters, name, axes, now_ms);
    let bounds = range.resolve(now_ms).0;
    let before = fingerprint(conn);
    if matches!(mode, CacheMode::Prefer) {
        if let Some(saved) = load(&path, &cache_key, before.as_deref(), bounds) {
            return Ok(saved);
        }
    }
    // Reports issue several SQL statements. Pin them to one committed view so
    // indexing in another connection cannot create a mixed-generation payload.
    let tx = if conn.is_autocommit() {
        Some(
            conn.unchecked_transaction()
                .map_err(|e| format!("begin report snapshot: {e}"))?,
        )
    } else {
        None
    };
    let mut out = build()?;
    *out.snapshot() = None;
    if let Some(tx) = tx {
        tx.commit()
            .map_err(|e| format!("finish report snapshot: {e}"))?;
    }
    if let Some(before) = before.filter(|before| fingerprint(conn).as_ref() == Some(before)) {
        if let Err(error) = save(&path, &cache_key, &before, bounds, &out) {
            crate::diag::log(&format!("[ailog] snapshot save unavailable: {error}"));
        }
    }
    Ok(out)
}

macro_rules! cached_report {
    ($($report:ty),+ $(,)?) => { $(
        impl Report for $report {
            fn snapshot(&mut self) -> &mut Option<SnapshotInfo> { &mut self.cache }
        }
    )+ };
}
cached_report!(
    super::query::Overview,
    super::query::SeriesReport,
    super::query::BreakdownReport,
    super::query::PivotReport,
    super::usage::UsageRhythmReport,
);
