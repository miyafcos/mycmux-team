//! Database lifecycle separation for the analytics cache.
//!
//! SQLite's immutable/read-only modes cannot safely recover a WAL database,
//! so readers use normal opens plus `query_only=ON`.  Initialization is kept
//! out of those reader opens: schema, additive migrations and legacy backfill
//! run once per database path in this process.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::ops::Deref;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant};

use rusqlite::{Connection, Transaction, TransactionBehavior};

struct WriterGate {
    lock: Mutex<()>,
    waiting: AtomicUsize,
}

// Unnamed connections share one key; file-backed connections share only with
// aliases of that same file. The map lock never covers a writer acquisition.
fn writer_gate_key(path: Option<&Path>) -> Option<PathBuf> {
    let path = path.filter(|path| !path.as_os_str().is_empty())?;
    Some(std::fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() { path.to_path_buf() }
        else { std::env::current_dir().expect("current directory for database path").join(path) }
    }))
}

fn writer_gate_for_path(path: Option<&Path>) -> &'static WriterGate {
    static GATES: OnceLock<Mutex<HashMap<Option<PathBuf>, &'static WriterGate>>> = OnceLock::new();
    let key = writer_gate_key(path);
    let mut gates = GATES.get_or_init(|| Mutex::new(HashMap::new()))
        .lock().unwrap_or_else(|error| error.into_inner());
    *gates.entry(key).or_insert_with(|| Box::leak(Box::new(WriterGate {
        lock: Mutex::new(()), waiting: AtomicUsize::new(0),
    })))
}

fn writer_gate(conn: &Connection) -> &'static WriterGate {
    writer_gate_for_path(conn.path().map(Path::new))
}

/// The transaction drops (and rolls back on error) before its writer guard.
/// Consuming commit also keeps the guard until SQLite has finished committing.
pub(crate) struct WriteTransaction<'conn> {
    transaction: Transaction<'conn>,
    _writer: MutexGuard<'static, ()>,
}

impl<'conn> Deref for WriteTransaction<'conn> {
    type Target = Transaction<'conn>;
    fn deref(&self) -> &Self::Target { &self.transaction }
}

impl WriteTransaction<'_> {
    pub(crate) fn commit(self) -> rusqlite::Result<()> { self.transaction.commit() }
}

// Keep product priority registered for the entire wait, including timeout and
// error exits. The worker must yield until the waiter leaves this scope.
struct WaitingWriter(&'static WriterGate);

impl WaitingWriter {
    fn new(gate: &'static WriterGate) -> Self {
        gate.waiting.fetch_add(1, Ordering::SeqCst);
        Self(gate)
    }
}

impl Drop for WaitingWriter {
    fn drop(&mut self) { self.0.waiting.fetch_sub(1, Ordering::SeqCst); }
}

#[cfg(test)]
pub(crate) fn waiting_writers_for_test(path: &Path) -> usize {
    writer_gate_for_path(Some(path)).waiting.load(Ordering::SeqCst)
}

/// Product callers acquire exactly once, immediately before their write tx.
/// Helpers borrowing that transaction must not acquire another writer guard.
pub(crate) fn write_transaction(conn: &Connection) -> rusqlite::Result<WriteTransaction<'_>> {
    let gate = writer_gate(conn);
    let waiting = WaitingWriter::new(gate);
    let writer = gate.lock.lock().unwrap_or_else(|error| error.into_inner());
    drop(waiting);
    Ok(WriteTransaction { transaction: conn.unchecked_transaction()?, _writer: writer })
}

/// Only interactive price updates bound their product-writer wait. All other
/// product callers keep write_transaction's blocking acquisition.
pub(crate) fn write_transaction_within(conn: &Connection, timeout: Duration)
    -> rusqlite::Result<WriteTransaction<'_>> {
    let gate = writer_gate(conn);
    let started = Instant::now();
    let waiting = WaitingWriter::new(gate);
    let writer = loop {
        match gate.lock.try_lock() {
            Ok(writer) => break writer,
            Err(TryLockError::Poisoned(error)) => break error.into_inner(),
            Err(TryLockError::WouldBlock) => {
                let remaining = timeout.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                        Some("database is locked".into()),
                    ));
                }
                std::thread::sleep(remaining.min(Duration::from_millis(1)));
            }
        }
    };
    drop(waiting);
    Ok(WriteTransaction { transaction: conn.unchecked_transaction()?, _writer: writer })
}

/// Background work never queues ahead of a product writer. Each acquisition
/// reserves SQLite's write lock before any snapshot reads (BEGIN IMMEDIATE).
pub(crate) fn try_write_transaction(conn: &Connection) -> rusqlite::Result<Option<WriteTransaction<'_>>> {
    let gate = writer_gate(conn);
    if gate.waiting.load(Ordering::SeqCst) != 0 { return Ok(None); }
    let writer = match gate.lock.try_lock() {
        Ok(writer) => writer,
        Err(TryLockError::Poisoned(error)) => error.into_inner(),
        Err(TryLockError::WouldBlock) => return Ok(None),
    };
    if gate.waiting.load(Ordering::SeqCst) != 0 { return Ok(None); }
    Ok(Some(WriteTransaction {
        transaction: Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?,
        _writer: writer,
    }))
}

#[cfg(test)]
type WriteHook = std::sync::Arc<dyn Fn(&Connection, &str) + Send + Sync>;

#[cfg(test)]
fn write_hooks() -> &'static Mutex<std::collections::HashMap<PathBuf, WriteHook>> {
    static HOOKS: OnceLock<Mutex<std::collections::HashMap<PathBuf, WriteHook>>> = OnceLock::new();
    HOOKS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

#[cfg(test)]
pub(crate) struct WriteHookGuard(PathBuf);

#[cfg(test)]
impl Drop for WriteHookGuard {
    fn drop(&mut self) { write_hooks().lock().unwrap().remove(&self.0); }
}

// SQLite reports the resolved file name (macOS /var is /private/var), so the
// registered fixture path and the connection's path must meet in one key.
#[cfg(test)]
fn write_hook_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).or_else(|error| match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => std::fs::canonicalize(parent).map(|parent| parent.join(name)),
        _ => Err(error),
    }).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
pub(crate) fn observe_write(path: &Path, hook: WriteHook) -> WriteHookGuard {
    let key = write_hook_key(path);
    assert!(write_hooks().lock().unwrap().insert(key.clone(), hook).is_none());
    WriteHookGuard(key)
}

#[cfg(test)]
pub(crate) fn write_checkpoint(conn: &Connection, stage: &str) {
    let key = conn.path().filter(|path| !path.is_empty()).map(|path| write_hook_key(Path::new(path)));
    let hook = key.and_then(|key| write_hooks().lock().unwrap().get(&key).cloned());
    if let Some(hook) = hook { hook(conn, stage); }
}

fn initialized_paths() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<bool>>>> {
    static PATHS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<bool>>>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn ensure_initialized(path: &Path) -> Result<(), String> {
    ensure_initialized_with(path, |_| {})
}

#[cfg(test)]
pub(crate) fn ensure_initialized_observed(
    path: &Path, observe: impl FnOnce(&Connection),
) -> Result<(), String> {
    ensure_initialized_with(path, observe)
}

fn ensure_initialized_with(path: &Path, observe: impl FnOnce(&Connection)) -> Result<(), String> {
    let normalized = path.to_path_buf();
    let initialized = {
        let mut paths = initialized_paths().lock().unwrap_or_else(|err| err.into_inner());
        paths.entry(normalized).or_insert_with(|| Arc::new(Mutex::new(false))).clone()
    };
    let mut initialized = initialized.lock().unwrap_or_else(|err| err.into_inner());
    if *initialized {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("create {parent:?}: {err}"))?;
    }
    let conn = Connection::open(path).map_err(|err| format!("open {path:?}: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(|err| format!("set busy timeout: {err}"))?;
    observe(&conn);
    crate::ailog::recovery::before_v3(&conn, path)?;
    crate::ailog::schema::init(&conn)?;
    crate::ailog::migrate::apply(&conn)?;
    crate::ailog::backfill::internal_origin(&conn)?;
    *initialized = true;
    crate::ailog::heavy_aggregate::schedule(path);
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
