//! Additive, restartable daily indexes for handoffs, rework and rhythm.
//!
//! A day becomes visible atomically. Readers complement its exact timestamp
//! interval with indexed raw reads, including gaps left by dirty/unbuilt days.
//! Handoff segments follow seq, not timestamps: a session may revisit an old
//! day, skip sequence numbers, or contain missing model/family observations.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Condvar, Mutex, OnceLock};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use super::{Filters, ResolvedRange};

pub const VERSION: &str = "1";
pub const MIN_FREE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
pub const DAY_MS: i64 = 86_400_000;
pub const SHIFT_MS: i64 = 32_400_000;
const MAX_WAL_BYTES: u64 = 64 * 1024 * 1024;
pub const YIELD_MS: u64 = 100;

pub const SCHEMA_SQL: &str = include_str!("sql/heavy_schema.sql");
pub const BUILD_SQL: &[(&str, &str)] = &[
    ("prepare", include_str!("sql/heavy_build_prepare.sql")),
    ("sequence", include_str!("sql/heavy_build_sequence.sql")),
    ("chunks", include_str!("sql/heavy_build_chunks.sql")),
    ("pairs", include_str!("sql/heavy_build_pairs.sql")),
    ("rhythm", include_str!("sql/heavy_build_rhythm.sql")),
    ("tools", include_str!("sql/heavy_build_tools.sql")),
    ("files", include_str!("sql/heavy_build_files.sql")),
    ("finish", include_str!("sql/heavy_build_finish.sql")),
];
pub const HANDOFF_SQL: &str = include_str!("sql/heavy_read_handoffs.sql");
pub const RHYTHM_SQL: &str = include_str!("sql/heavy_read_rhythm.sql");
pub const TOOL_SQL: &str = include_str!("sql/heavy_read_tools.sql");
pub const FILE_SQL: &str = include_str!("sql/heavy_read_files.sql");

pub fn migrate(conn: &Connection) -> Result<(), String> {
    // Foreground initialization only adds schema. Source reconciliation and
    // every history-sized operation belong to the low-priority worker.
    conn.execute_batch(SCHEMA_SQL).map_err(|e| format!("add heavy aggregates: {e}"))
}

pub const SOURCE_MARK_SQL: &str = include_str!("sql/heavy_source_fingerprint.sql");

/// v0.90.0 already maintains these keys with its report-cache triggers.
pub fn source_mark(conn: &Connection) -> Result<String, String> {
    let (id, revision): (Option<String>, Option<String>) = conn.query_row(SOURCE_MARK_SQL, [],
        |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
    let (Some(id), Some(revision)) = (id, revision) else {
        return Err("source revision is unavailable".into());
    };
    serde_json::to_string(&("v1", id, revision)).map_err(|e| e.to_string())
}

fn checked_databases() -> &'static Mutex<HashSet<String>> {
    static CHECKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CHECKED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn database_id(conn: &Connection) -> Result<String, String> {
    conn.query_row("SELECT value FROM index_state WHERE key='report_database_id'", [],
        |r| r.get(0)).map_err(|e| e.to_string())
}

fn startup_checked(conn: &Connection) -> bool {
    database_id(conn).map(|id| checked_databases().lock()
        .unwrap_or_else(|e| e.into_inner()).contains(&id)).unwrap_or(false)
}

#[cfg(test)]
pub(crate) fn forget_startup_check(conn: &Connection) {
    if let Ok(id) = database_id(conn) {
        checked_databases().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }
}

fn persist_source_mark(conn: &Connection) -> Result<(), String> {
    let mark = source_mark(conn)?;
    conn.execute("INSERT INTO index_state(key,value) VALUES ('heavy_aggregate_source_mark',?1)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value", [mark]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_source_mark(conn: &Connection) -> Result<(), String> {
    // An ingestion that wins the startup race must not hide an old-version
    // mismatch before the worker has checked it.
    if startup_checked(conn) { persist_source_mark(conn)?; }
    Ok(())
}

pub const RESET_BATCH_ROWS: usize = 256;
const RESET_TABLES: &[(&str, &str)] = &[
    ("heavy_aggregate_day", "day"),
    ("heavy_aggregate_dirty", "day"),
    ("heavy_session_day", "day,kind,session_id"),
    ("heavy_handoff_chunk", "day,granularity,kind,session_id,segment"),
    ("heavy_handoff_pair", "day,granularity,kind,session_id,segment,from_name,to_name"),
    ("heavy_tool_day", "day,kind,session_id,name,target"),
    ("heavy_file_session", "kind,session_id,path"),
    ("heavy_file_ready", "kind,session_id"),
    ("heavy_rhythm_day", "day,hour"),
];

/// Called only by the worker, before its first build. A persisted reset stage
/// survives interruption; each call removes at most 256 rows in one table.
/// Readers stay on G1-3 until reconciliation (including reset) is complete.
pub(crate) fn reconcile_startup(
    conn: &Connection, checkpoint: &dyn Fn(&str) -> Result<(), String>,
) -> Result<bool, String> {
    if startup_checked(conn) { return Ok(true); }
    let tx = super::db::try_write_transaction(conn).map_err(|e| e.to_string())?
        .ok_or("ailog product writer busy")?;
    // Take the write lock before comparing revisions or publishing readiness.
    tx.execute("UPDATE index_state SET value=value WHERE key='heavy_aggregate_version'", [])
        .map_err(|e| e.to_string())?;
    let reset: Option<usize> = tx.query_row(
        "SELECT CAST(value AS INTEGER) FROM index_state WHERE key='heavy_aggregate_reset'", [],
        |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    if let Some(stage) = reset {
        if let Some((table, keys)) = RESET_TABLES.get(stage) {
            let deleted = tx.execute(&format!("DELETE FROM {table} WHERE ({keys}) IN
                (SELECT {keys} FROM {table} LIMIT {RESET_BATCH_ROWS})"), [])
                .map_err(|e| e.to_string())?;
            if deleted < RESET_BATCH_ROWS {
                tx.execute("UPDATE index_state SET value=?1 WHERE key='heavy_aggregate_reset'",
                    [(stage + 1).to_string()]).map_err(|e| e.to_string())?;
            }
            checkpoint("reset_commit")?;
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(false);
        }
        tx.execute("DELETE FROM index_state WHERE key='heavy_aggregate_reset'", [])
            .map_err(|e| e.to_string())?;
    } else {
        let current = source_mark(&tx)?;
        let stored: Option<String> = tx.query_row(
            "SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'", [],
            |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        let pristine = stored.is_none() && !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM heavy_aggregate_day)
                OR EXISTS(SELECT 1 FROM index_state WHERE key='heavy_aggregate_cursor')", [],
            |r| r.get::<_, bool>(0)).map_err(|e| e.to_string())?;
        if stored.as_deref() != Some(current.as_str()) && !pristine {
            tx.execute("INSERT INTO index_state(key,value) VALUES ('heavy_aggregate_reset','0')", [])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM index_state
                WHERE key IN ('heavy_aggregate_cursor','heavy_aggregate_lower_day')", [])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            checkpoint("reset_mark")?;
            return Ok(false);
        }
    }
    persist_source_mark(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    checked_databases().lock().unwrap_or_else(|e| e.into_inner()).insert(database_id(conn)?);
    Ok(true)
}

pub fn available(conn: &Connection) -> bool {
    conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_version'",
                   [], |r| r.get::<_, String>(0)).optional().ok().flatten().as_deref() == Some(VERSION)
}

/// Every nontrivial filter keeps the complete G1-3 semantics. In particular
/// model/effort predicates change adjacency, and file totals cover the entire
/// lifetime of each selected session, rather than just its selected days.
pub fn eligible(conn: &Connection, filters: &Filters) -> bool {
    filters.kinds.is_empty() && filters.models.is_empty() && filters.projects.is_empty()
        && filters.branches.is_empty() && filters.efforts.is_empty() && filters.origins.is_empty()
        && filters.min_cost.is_none() && filters.query.as_deref().unwrap_or("").is_empty()
        && available(conn) && startup_checked(conn)
}


/// Missing initial-build days keep the entire G1-3 reader, including its
/// selected-key rollups and sequential all-history scans. Only already
/// published dirty days (at most seven) may be complemented by raw gaps.
pub const MAX_DIRTY_DAYS: i64 = 7;

pub fn eligible_for_range(conn: &Connection, filters: &Filters, range: &ResolvedRange) -> bool {
    eligible(conn, filters) && range_ready(conn, range).unwrap_or(false)
}

fn range_ready(conn: &Connection, range: &ResolvedRange) -> Result<bool, String> {
    let (first,last): (Option<i64>,Option<i64>) = conn.query_row(
        "SELECT (SELECT MIN(ts) FROM turn),(SELECT MAX(ts) FROM turn)",[],
        |r| Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    let (Some(first),Some(last))=(first,last) else { return Ok(true); };
    let mut lo=((range.from+SHIFT_MS)/DAY_MS).max((first+SHIFT_MS)/DAY_MS);
    let mut hi=((range.to+SHIFT_MS)/DAY_MS).min((last+SHIFT_MS)/DAY_MS);
    if day_bounds(lo).0<range.from { lo+=1; }
    if day_bounds(hi).1>range.to { hi-=1; }
    if lo>hi { return Ok(true); } // Only partial boundary days: all raw.
    let (published,dirty):(i64,i64)=conn.query_row(
        "SELECT COUNT(*),COALESCE(SUM(
            EXISTS(SELECT 1 FROM heavy_aggregate_dirty x WHERE x.day=d.day)
            OR EXISTS(SELECT 1 FROM rollup_dirty x WHERE x.day=d.day)),0)
         FROM heavy_aggregate_day d WHERE d.day>=?1 AND d.day<=?2
           AND d.start_ts>=?3 AND d.end_ts<=?4",
        params![lo,hi,range.from,range.to],|r|Ok((r.get(0)?,r.get(1)?)))
        .map_err(|e|e.to_string())?;
    Ok(published==hi-lo+1 && dirty<=MAX_DIRTY_DAYS)
}

pub fn mark_session_dirty(conn: &Connection, kind: &str, session_id: &str) -> Result<(), String> {
    if !available(conn) { return Ok(()); }
    conn.execute("INSERT OR IGNORE INTO heavy_aggregate_dirty(day)
        SELECT (ts+32400000)/86400000 FROM turn WHERE kind=?1 AND session_id=?2
        UNION SELECT day FROM heavy_session_day WHERE kind=?1 AND session_id=?2
        UNION SELECT (ts+32400000)/86400000 FROM tool_event WHERE kind=?1 AND session_id=?2
        UNION SELECT day FROM heavy_tool_day WHERE kind=?1 AND session_id=?2",
        params![kind, session_id]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO heavy_file_ready(kind,session_id,ready) VALUES (?1,?2,0)
        ON CONFLICT(kind,session_id) DO UPDATE SET ready=0",params![kind,session_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_all_dirty(conn: &Connection) -> Result<(), String> {
    if !available(conn) { return Ok(()); }
    conn.execute("INSERT OR IGNORE INTO heavy_aggregate_dirty(day)
        SELECT (ts+32400000)/86400000 FROM turn UNION SELECT day FROM heavy_aggregate_day",[])
        .map_err(|e|e.to_string())?;
    conn.execute("UPDATE heavy_file_ready SET ready=0",[]).map_err(|e|e.to_string())?;
    record_source_mark(conn)

}

pub fn day_bounds(day: i64) -> (i64, i64) {
    // SQLite integer division truncates towards zero. Day zero therefore
    // spans both sides of the epoch; preserve the existing reports' buckets.
    if day > 0 {
        (day * DAY_MS - SHIFT_MS, (day + 1) * DAY_MS - SHIFT_MS - 1)
    } else if day < 0 {
        ((day - 1) * DAY_MS - SHIFT_MS + 1, day * DAY_MS - SHIFT_MS)
    } else {
        (-DAY_MS - SHIFT_MS + 1, DAY_MS - SHIFT_MS - 1)
    }
}

fn next_day(conn: &Connection) -> Result<Option<(i64, bool)>, String> {
    if let Some(day) = conn.query_row("SELECT MIN(day) FROM heavy_aggregate_dirty", [],
                                    |r| r.get::<_, Option<i64>>(0)).map_err(|e|e.to_string())? {
        return Ok(Some((day, false)));
    }
    let (first,last): (Option<i64>,Option<i64>) = conn.query_row(
        "SELECT (SELECT MIN(ts) FROM turn),(SELECT MAX(ts) FROM turn)",[],|r| Ok((r.get(0)?,r.get(1)?)))
        .map_err(|e|e.to_string())?;
    let (Some(first),Some(last)) = (first,last) else { return Ok(None); };
    let first = (first+SHIFT_MS)/DAY_MS;
    let lower: Option<i64> = conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM index_state WHERE key='heavy_aggregate_lower_day'",
        [], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    let mut cursor: Option<i64> = conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM index_state WHERE key='heavy_aggregate_cursor'",
        [], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    if lower.map(|day| first < day).unwrap_or(true) {
        // Also repairs a cursor written before lower bounds were recorded.
        // Store both keys atomically so an interruption cannot skip the gap.
        conn.execute("INSERT INTO index_state(key,value) VALUES ('heavy_aggregate_lower_day',?1)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value", [first.to_string()])
            .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO index_state(key,value) VALUES ('heavy_aggregate_cursor',?1)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value", [(first-1).to_string()])
            .map_err(|e| e.to_string())?;
        cursor = Some(first-1);
    }
    let day = cursor.map(|d| d+1).unwrap_or(first).max(first);
    let last=(last+SHIFT_MS)/DAY_MS;
    if day>last { return Ok(None); }
    // A source-mark reconciliation can rebuild days through the dirty queue
    // before the initial cursor advances. Skip their completed publications.
    let missing=conn.query_row("SELECT ?1 WHERE NOT EXISTS(
            SELECT 1 FROM heavy_aggregate_day WHERE day=?1)
        UNION ALL SELECT d.day+1 FROM heavy_aggregate_day d
        WHERE d.day>=?1 AND d.day<?2 AND NOT EXISTS(
            SELECT 1 FROM heavy_aggregate_day n WHERE n.day=d.day+1)
        ORDER BY 1 LIMIT 1",params![day,last],|r|r.get::<_,i64>(0))
        .optional().map_err(|e|e.to_string())?;
    Ok(missing.map(|day|(day,true)))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step { Built(i64), Resetting, Complete, LowDisk }

/// One short transaction. Injected space/checkpoint functions make low-space,
/// mid-chunk cancellation, rollback and restart behavior directly testable.
pub fn build_next(
    conn: &mut Connection, free_bytes: Option<u64>,
    checkpoint: &dyn Fn(&str) -> Result<(), String>,
) -> Result<Step, String> {
    if !matches!(free_bytes,Some(bytes) if bytes>=MIN_FREE_BYTES) { return Ok(Step::LowDisk); }
    if !reconcile_startup(conn, checkpoint)? { return Ok(Step::Resetting); }
    let tx = super::db::try_write_transaction(conn).map_err(|e| e.to_string())?
        .ok_or("ailog product writer busy")?;
    // Lower/cursor repair belongs to this day's transaction, never a nested tx.
    let Some((day,advance)) = next_day(&tx)? else {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(Step::Complete);
    };
    let (start,end)=day_bounds(day);
    let values=[day,start,end,i64::from(advance)];
    for (stage,sql) in BUILD_SQL {
        checkpoint(stage)?;
        for statement in sql.split(';').filter(|s|!s.trim().is_empty()) {
            let mut stmt=tx.prepare(statement).map_err(|e|format!("heavy {stage}: {e}"))?;
            let count=stmt.parameter_count();
            stmt.execute(params_from_iter(values.iter().take(count)))
                .map_err(|e|format!("heavy {stage}: {e}"))?;
        }
    }
    record_source_mark(&tx)?;
    checkpoint("commit")?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(Step::Built(day))
}

pub fn path(raw_turns: u64, rollup_rows: u64) -> &'static str {
    match (raw_turns>0,rollup_rows>0) { (true,true)=>"hybrid",(false,true)=>"rollup",_=>"raw" }
}

pub fn read_handoffs(conn: &Connection, range: &ResolvedRange, granularity: &str)
    -> Result<(Vec<super::query::Handoff>,super::query::ReportTimings),String> {
    let started=Instant::now();
    let granularity=if granularity=="raw" { "raw" } else { "family" };
    let mut stmt=conn.prepare(HANDOFF_SQL).map_err(|e|e.to_string())?;
    let rows=stmt.query_map(params![range.from,range.to,granularity],|r| Ok((
        r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<i64>>(2)?,
        r.get::<_,i64>(3)?,r.get::<_,i64>(4)?))).map_err(|e|e.to_string())?;
    let mut handoffs=Vec::new();
    let (mut raw,mut rollup)=(0,0);
    for row in rows {
        let (from,to,n,r,a)=row.map_err(|e|e.to_string())?;
        raw=r.max(0) as u64; rollup=a.max(0) as u64;
        if let (Some(from),Some(to),Some(count))=(from,to,n) {
            handoffs.push(super::query::Handoff { from,to,count });
        }
    }
    Ok((handoffs,super::query::ReportTimings {
        sql_ms:started.elapsed().as_millis() as u64,rows_scanned:raw+rollup,
        raw_rows:raw,rollup_rows:rollup,raw_turns:raw,raw_turns_measured:true,build_ms:0,path:path(raw,rollup),
    }))
}

pub fn read_rework(conn: &Connection, range: &ResolvedRange)
    -> Result<(Vec<super::query::ToolRankingRow>,Vec<super::query::FileRankingRow>,super::query::ReportTimings),String> {
    let started=Instant::now();
    // Keep selected keys, tool totals and lifetime file summaries in the same
    // read snapshot even when ingestion commits between the two statements.
    let snapshot=if conn.is_autocommit() { Some(conn.unchecked_transaction().map_err(|e|e.to_string())?) } else { None };
    let mut tools=conn.prepare(TOOL_SQL).map_err(|e|e.to_string())?;
    let tools=tools.query_map(params![range.from,range.to],|r| {
        let executions:Option<i64>=r.get(2)?; let failures:Option<i64>=r.get(3)?;
        let row=if let (Some(executions),Some(failures))=(executions,failures) {
            Some(super::query::ToolRankingRow { name:r.get(0)?,target:r.get(1)?,executions,failures,
                failure_rate:failures as f64/executions as f64 })
        } else { None };
        Ok((row,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?))
    }).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let (tool_raw_turns,raw_events,aggregate_events,ready_days)=tools.first().map(|r|(r.1 as u64,r.2 as u64,r.3 as u64,r.4 as u64)).unwrap_or_default();
    let tools=tools.into_iter().filter_map(|r|r.0).collect::<Vec<_>>();
    let mut files=conn.prepare(FILE_SQL).map_err(|e|e.to_string())?;
    let files=files.query_map(params![range.from,range.to],|r| {
        let path:Option<String>=r.get(0)?;
        let row=if let Some(path)=path { Some(super::query::FileRankingRow {path,edit_count:r.get(1)?,session_count:r.get(2)?}) } else { None };
        Ok((row,
            r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?))
    }).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let (raw_files,aggregate_files,file_raw_turns)=files.first().map(|r|(r.1 as u64,r.2 as u64,r.3 as u64)).unwrap_or_default();
    let files=files.into_iter().filter_map(|r|r.0).collect::<Vec<_>>();
    drop(snapshot);
    let raw_turns=tool_raw_turns+file_raw_turns;
    let raw_rows=raw_turns+raw_events+raw_files;
    let rollup_rows=aggregate_events+aggregate_files;
    let route=if ready_days>0 && raw_rows==0 { "rollup" } else { path(raw_rows,rollup_rows) };
    Ok((tools,files,super::query::ReportTimings {
        sql_ms:started.elapsed().as_millis() as u64,rows_scanned:raw_rows+rollup_rows,
        raw_rows,rollup_rows,raw_turns,raw_turns_measured:true,build_ms:0,path:route,
    }))
}

fn free_space(path: &Path) -> Option<u64> {
    let key=|p:&Path| { let v=p.to_string_lossy().replace('\\',"/");
        if cfg!(windows) { v.to_lowercase() } else { v } };
    let target=key(path);
    sysinfo::Disks::new_with_refreshed_list().list().iter().filter_map(|disk| {
        let mount=key(disk.mount_point());
        target.starts_with(&mount).then_some((mount.len(),disk.available_space()))
    }).max_by_key(|(len,_)|*len).map(|(_,bytes)|bytes)
}

pub(crate) fn lower_priority() {
    #[cfg(target_os="windows")]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentThread,SetThreadPriority,THREAD_PRIORITY_LOWEST};
        let _=SetThreadPriority(GetCurrentThread(),THREAD_PRIORITY_LOWEST);
    }
    #[cfg(target_os="macos")]
    unsafe {
        unsafe extern "C" { fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32; }
        let _=pthread_set_qos_class_self_np(0x09,0);
    }
    #[cfg(target_os="linux")]
    unsafe { libc::setpriority(libc::PRIO_PROCESS,libc::syscall(libc::SYS_gettid) as u32,10); }
}

// Bit 0 owns the worker (including its idle wait); bit 1 remembers an
// ingestion request at a completion/wait boundary. Scheduling also notifies
// under the wait mutex so no committed refresh can be lost.
static RUNNING: AtomicU8=AtomicU8::new(0);

fn request_worker(state:&AtomicU8)->bool {
    state.fetch_or(3,Ordering::AcqRel)&1==0
}

// Keep ownership while idle, and remember any request at the pass boundary.
fn finish_pass(state: &AtomicU8) -> bool {
    state.fetch_and(1, Ordering::AcqRel) & 2 != 0
}

type Wake = (Mutex<()>, Condvar);
fn worker_wake() -> &'static Wake {
    static WAKE: OnceLock<Wake> = OnceLock::new();
    WAKE.get_or_init(|| (Mutex::new(()), Condvar::new()))
}

fn wait_for_request(state: &AtomicU8, wake: &Wake, timeout: Duration) -> bool {
    let guard = wake.0.lock().unwrap_or_else(|e| e.into_inner());
    let _guard = wake.1.wait_timeout_while(guard, timeout,
        |_| state.load(Ordering::Acquire) & 2 == 0).unwrap_or_else(|e| e.into_inner());
    state.load(Ordering::Acquire) & 2 != 0
}

pub(crate) fn record_idle_source_mark(conn: &Connection) -> Result<(), String> {
    let tx = super::db::try_write_transaction(conn).map_err(|e| e.to_string())?
        .ok_or("ailog product writer busy")?;
    record_source_mark(&tx)?;
    tx.commit().map_err(|e| e.to_string())
}

/// At most one low-priority builder per process. Scheduling performs no DB
/// scan on the caller's thread. Tests exercise build_next explicitly.
pub fn schedule(path: &Path) {
    if cfg!(test) { return; }
    if !request_worker(&RUNNING) {
        // Use the waiter's mutex so a notification cannot fall between its
        // predicate check and the actual wait.
        let wake = worker_wake();
        let _guard = wake.0.lock().unwrap_or_else(|e| e.into_inner());
        wake.1.notify_one();
        return;
    }
    let path=path.to_path_buf();
    if std::thread::Builder::new().name("ailog-daily-aggregates".into()).spawn(move || {
        struct Release;
        impl Drop for Release { fn drop(&mut self) { RUNNING.store(0,Ordering::Release); } }
        let _release=Release;
        RUNNING.fetch_and(1,Ordering::AcqRel);
        lower_priority();
        let result=(|| -> Result<(),String> {
            let mut conn=Connection::open_with_flags(&path,rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|e|e.to_string())?;
            conn.execute_batch("PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA busy_timeout=100;")
                .map_err(|e|e.to_string())?;
            let started=Instant::now();
            let mut days=0;
            let mut reported_complete=false;
            loop {
                match build_next(&mut conn,free_space(&path),&|_|Ok(())) {
                    Ok(Step::Built(_))=> { days+=1; reported_complete=false; },
                    Ok(Step::Resetting)=> { reported_complete=false; },
                    Ok(Step::Complete)=> {
                        if finish_pass(&RUNNING) { continue; }
                        if !reported_complete {
                            crate::diag::log(&format!("[ailog] heavy_aggregate action=complete version={VERSION} days={days} elapsed_ms={}",started.elapsed().as_millis()));
                            reported_complete=true;
                        }
                        if !wait_for_request(&RUNNING, worker_wake(), Duration::from_secs(180)) {
                            loop {
                                match record_idle_source_mark(&conn) {
                                    Ok(()) => break,
                                    Err(e) if e.contains("locked") || e.contains("busy") => {
                                        if wait_for_request(&RUNNING, worker_wake(), Duration::from_millis(YIELD_MS)) { break; }
                                    },
                                    Err(e) => return Err(e),
                                }
                            }
                        }
                        continue;
                    },
                    Ok(Step::LowDisk)=> {
                        crate::diag::log("[ailog] heavy_aggregate action=paused reason=disk_below_5GiB_or_unknown");
                        return Ok(());
                    },
                    Err(e) if e.contains("locked") || e.contains("busy")=> {
                        std::thread::sleep(Duration::from_millis(100)); continue;
                    },
                    Err(e)=>return Err(e),
                }
                // Passive checkpoints never hold up a reader or the indexer.
                let _=conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)");
                let wal=std::path::PathBuf::from(format!("{}-wal",path.to_string_lossy()));
                if wal.metadata().map(|m|m.len()>MAX_WAL_BYTES).unwrap_or(false) {
                    let _=conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
                    if wal.metadata().map(|m|m.len()>MAX_WAL_BYTES).unwrap_or(false) {
                        crate::diag::log("[ailog] heavy_aggregate action=paused reason=wal_reader_hold limit_mib=64");
                        return Ok(());
                    }
                }
                std::thread::sleep(Duration::from_millis(YIELD_MS));
            }
        })();
        if let Err(error)=result { crate::diag::log(&format!("[ailog] heavy_aggregate action=paused reason=error detail={error}")); }
    }).is_err() { RUNNING.store(0,Ordering::Release); }
}

#[cfg(test)]
#[test]
fn daily_aggregate_worker_keeps_requests_at_the_completion_boundary() {
    let state=AtomicU8::new(0);
    assert!(request_worker(&state));
    state.fetch_and(1,Ordering::AcqRel);
    assert!(!request_worker(&state));
    assert!(finish_pass(&state),"a committed index requires one more pass");
    assert!(!finish_pass(&state));
    assert_eq!(state.load(Ordering::Acquire),1,"the idle worker keeps ownership");
    let wake=(Mutex::new(()),Condvar::new());
    assert!(!wait_for_request(&state,&wake,Duration::ZERO));
    assert!(!request_worker(&state),"an idle worker receives the next request");
    assert!(wait_for_request(&state,&wake,Duration::from_millis(1)));
    assert!(finish_pass(&state),"the wait boundary cannot lose a request");
    assert!(!finish_pass(&state));
}
