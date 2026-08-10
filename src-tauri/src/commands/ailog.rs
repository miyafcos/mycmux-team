//! Tauri command surface for the AI session log analytics module.
//!
//! Every command here is declared async: each one opens a SQLite connection
//! and reads from disk, which must never happen on the main thread. Keeping
//! them all async is also what keeps `tests/test_command_sync_contract.py`
//! green without extending its allowlist.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::ailog::index::{self, IndexOptions, IndexProgress};
use crate::ailog::{query, Filters, Range};

pub const INDEX_PROGRESS_EVENT: &str = "ailog://index-progress";

/// Live indexer state. One indexing pass runs at a time; a second start
/// request is refused rather than queued so two writers can never race.
struct IndexerState {
    running: AtomicBool,
    cancel: Arc<AtomicBool>,
    files_done: AtomicUsize,
    files_total: AtomicUsize,
    sessions: AtomicUsize,
    last_finished_at: Mutex<i64>,
    last_error: Mutex<Option<String>>,
}

impl IndexerState {
    fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
            files_done: AtomicUsize::new(0),
            files_total: AtomicUsize::new(0),
            sessions: AtomicUsize::new(0),
            last_finished_at: Mutex::new(0),
            last_error: Mutex::new(None),
        }
    }
}

fn indexer_state() -> &'static IndexerState {
    static STATE: OnceLock<IndexerState> = OnceLock::new();
    STATE.get_or_init(IndexerState::new)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn open() -> Result<rusqlite::Connection, String> {
    let path = crate::ailog::db_path()?;
    crate::ailog::open_db(&path)
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStartArgs {
    #[serde(default)]
    pub full: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStartResult {
    pub started: bool,
    pub already_running: bool,
}

#[tauri::command(async)]
pub async fn ailog_index_start(
    app: AppHandle,
    args: IndexStartArgs,
) -> Result<IndexStartResult, String> {
    let state = indexer_state();
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(IndexStartResult {
            started: false,
            already_running: true,
        });
    }

    state.cancel.store(false, Ordering::SeqCst);
    state.files_done.store(0, Ordering::Relaxed);
    state.files_total.store(0, Ordering::Relaxed);
    state.sessions.store(0, Ordering::Relaxed);
    *state
        .last_error
        .lock()
        .unwrap_or_else(|err| err.into_inner()) = None;

    let db_path = match crate::ailog::db_path() {
        Ok(path) => path,
        Err(err) => {
            state.running.store(false, Ordering::SeqCst);
            return Err(err);
        }
    };

    let mut options = IndexOptions::new(db_path);
    options.full = args.full;
    let cancel = state.cancel.clone();

    // The pass owns its own tasks and reports back through the event channel;
    // the command returns as soon as it has been handed off so the UI is never
    // blocked behind a multi-minute first index.
    tauri::async_runtime::spawn(async move {
        let sink: index::ProgressSink = {
            let app = app.clone();
            Arc::new(move |progress: IndexProgress| {
                let state = indexer_state();
                state
                    .files_done
                    .store(progress.files_done, Ordering::Relaxed);
                state
                    .files_total
                    .store(progress.files_total, Ordering::Relaxed);
                if progress.sessions > 0 {
                    state.sessions.store(progress.sessions, Ordering::Relaxed);
                }
                let _ = app.emit(INDEX_PROGRESS_EVENT, progress);
            })
        };

        let result = index::run_index(options, cancel, Some(sink)).await;
        let state = indexer_state();
        match result {
            Ok(report) => {
                state.sessions.store(report.sessions, Ordering::Relaxed);
                *state
                    .last_finished_at
                    .lock()
                    .unwrap_or_else(|err| err.into_inner()) = now_ms();
                if !report.errors.is_empty() {
                    *state
                        .last_error
                        .lock()
                        .unwrap_or_else(|err| err.into_inner()) = Some(report.errors.join("; "));
                }
            }
            Err(err) => {
                *state
                    .last_error
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(err);
            }
        }
        state.running.store(false, Ordering::SeqCst);
    });

    Ok(IndexStartResult {
        started: true,
        already_running: false,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexCancelResult {
    pub cancelled: bool,
}

#[tauri::command(async)]
pub async fn ailog_index_cancel() -> Result<IndexCancelResult, String> {
    let state = indexer_state();
    let running = state.running.load(Ordering::SeqCst);
    state.cancel.store(true, Ordering::SeqCst);
    Ok(IndexCancelResult { cancelled: running })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub running: bool,
    pub files_done: usize,
    pub files_total: usize,
    pub sessions: usize,
    pub last_finished_at: i64,
    pub last_error: Option<String>,
}

#[tauri::command(async)]
pub async fn ailog_index_status() -> Result<IndexStatus, String> {
    let state = indexer_state();
    let persisted = open()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT value FROM index_state WHERE key = 'last_finished_at'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let in_memory = *state
        .last_finished_at
        .lock()
        .unwrap_or_else(|err| err.into_inner());

    Ok(IndexStatus {
        running: state.running.load(Ordering::SeqCst),
        files_done: state.files_done.load(Ordering::Relaxed),
        files_total: state.files_total.load(Ordering::Relaxed),
        sessions: state.sessions.load(Ordering::Relaxed),
        last_finished_at: in_memory.max(persisted),
        last_error: state
            .last_error
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone(),
    })
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub async fn ailog_overview(
    range: Option<Range>,
    filters: Option<Filters>,
) -> Result<query::Overview, String> {
    let conn = open()?;
    query::overview(
        &conn,
        &range.unwrap_or_default(),
        &filters.unwrap_or_default(),
        now_ms(),
    )
}

#[tauri::command(async)]
pub async fn ailog_series(
    range: Option<Range>,
    filters: Option<Filters>,
    options: Option<query::SeriesOptions>,
) -> Result<query::SeriesReport, String> {
    let conn = open()?;
    query::series(
        &conn,
        &range.unwrap_or_default(),
        &filters.unwrap_or_default(),
        &options.unwrap_or_default(),
        now_ms(),
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownArgs {
    #[serde(default = "default_dimension")]
    pub dimension: String,
}

fn default_dimension() -> String {
    "model".to_string()
}

#[tauri::command(async)]
pub async fn ailog_breakdown(
    range: Option<Range>,
    filters: Option<Filters>,
    options: Option<BreakdownArgs>,
) -> Result<query::BreakdownReport, String> {
    let conn = open()?;
    let dimension = options
        .map(|value| value.dimension)
        .unwrap_or_else(default_dimension);
    query::breakdown(
        &conn,
        &range.unwrap_or_default(),
        &filters.unwrap_or_default(),
        &dimension,
        now_ms(),
    )
}

#[tauri::command(async)]
pub async fn ailog_sessions(
    range: Option<Range>,
    filters: Option<Filters>,
    options: Option<query::SessionsOptions>,
) -> Result<query::SessionsReport, String> {
    let conn = open()?;
    query::sessions(
        &conn,
        &range.unwrap_or_default(),
        &filters.unwrap_or_default(),
        &options.unwrap_or_default(),
        now_ms(),
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetailArgs {
    pub kind: String,
    pub session_id: String,
}

#[tauri::command(async)]
pub async fn ailog_session_detail(args: SessionDetailArgs) -> Result<query::SessionDetail, String> {
    let conn = open()?;
    query::session_detail(&conn, &args.kind, &args.session_id)
}

#[tauri::command(async)]
pub async fn ailog_models(
    range: Option<Range>,
    filters: Option<Filters>,
    options: Option<query::ModelsOptions>,
) -> Result<query::ModelsReport, String> {
    let conn = open()?;
    query::models(
        &conn,
        &range.unwrap_or_default(),
        &filters.unwrap_or_default(),
        &options.unwrap_or_default(),
        now_ms(),
    )
}

#[tauri::command(async)]
pub async fn ailog_efficiency(
    range: Option<Range>,
    filters: Option<Filters>,
) -> Result<query::EfficiencyReport, String> {
    let conn = open()?;
    query::efficiency(
        &conn,
        &range.unwrap_or_default(),
        &filters.unwrap_or_default(),
        now_ms(),
    )
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub async fn ailog_get_prices() -> Result<Vec<query::PriceEntry>, String> {
    let conn = open()?;
    query::get_prices(&conn)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPriceResult {
    pub model: String,
    pub repriced_sessions: usize,
}

#[tauri::command(async)]
pub async fn ailog_set_price(entry: query::PriceEntry) -> Result<SetPriceResult, String> {
    let mut conn = open()?;
    // Changing a rate changes every stored cost derived from it, so the whole
    // database is re-priced rather than left inconsistent until the next index.
    let repriced = query::set_price(&mut conn, &entry)?;
    Ok(SetPriceResult {
        model: entry.model,
        repriced_sessions: repriced,
    })
}
