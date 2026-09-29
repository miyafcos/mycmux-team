//! The session index behind 続きから (launcher) and Ctrl+P.
//!
//! Built in-process from the vendored `crsm-core` crate (see
//! `crates/crsm-core/VENDOR.md`) rather than by running the `crsm` CLI. A macOS
//! GUI app inherits launchd's minimal PATH, so the binary was never found no
//! matter where it was installed, and both lists were permanently empty there.

use crsm_core::path_norm::home_dir;
use crsm_core::sessions::{load_cached_sessions, CACHE_FRESH_TTL_SECS};
use crsm_core::{
    create_handoff_file, list_all_sessions, rank_sessions, AgentKind, HandoffRequest, ListOptions,
    SessionEntry,
};
use serde_json::Value;
use std::str::FromStr;
use std::sync::{Arc, Condvar, Mutex};

/// What the palette asks for when it does not say; kept here so a caller that
/// omits `limit` gets the same page as before.
const DEFAULT_LIST_LIMIT: usize = 200;
const DEFAULT_RECENT_TURNS: usize = 20;

const CACHE_FRESH_TTL_MS: i64 = CACHE_FRESH_TTL_SECS * 1000;

#[derive(Debug)]
struct SessionSnapshot {
    sessions: Vec<SessionEntry>,
    generated_at_ms: i64,
}

type RefreshResult = Result<Arc<SessionSnapshot>, String>;

#[derive(Default)]
struct RefreshFlight {
    result: Mutex<Option<RefreshResult>>,
    ready: Condvar,
}

impl RefreshFlight {
    fn wait(&self) -> RefreshResult {
        let mut result = self.result.lock().unwrap_or_else(|e| e.into_inner());
        while result.is_none() {
            result = self.ready.wait(result).unwrap_or_else(|e| e.into_inner());
        }
        result.as_ref().unwrap().clone()
    }
}

#[derive(Default)]
struct RefreshState {
    flight: Option<Arc<RefreshFlight>>,
    generation: u64,
}

#[derive(Default)]
struct RefreshCoordinator(Mutex<RefreshState>);

impl RefreshCoordinator {
    fn status(&self) -> (u64, bool) {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        (state.generation, state.flight.is_some())
    }

    /// A cache reader whose generation changed must reread the snapshot instead
    /// of starting a redundant scan after the preceding one has just finished.
    fn claim(&self, observed: Option<u64>) -> Option<(Arc<RefreshFlight>, bool)> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(flight) = &state.flight {
            return Some((flight.clone(), false));
        }
        if observed.is_some_and(|value| value != state.generation) {
            return None;
        }
        let flight = Arc::new(RefreshFlight::default());
        state.flight = Some(flight.clone());
        Some((flight, true))
    }

    fn run(&self, flight: &Arc<RefreshFlight>, scan: impl FnOnce() -> RefreshResult) -> RefreshResult {
        // Wake every waiter on failure, including an unexpected provider panic.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(scan))
            .unwrap_or_else(|_| Err("crsm session refresh panicked".to_string()));
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        *flight.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
        state.flight = None;
        state.generation += 1;
        flight.ready.notify_all();
        result
    }
}

static REFRESHES: RefreshCoordinator = RefreshCoordinator(Mutex::new(RefreshState {
    flight: None,
    generation: 0,
}));

fn cache_is_fresh(generated_at_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(generated_at_ms).max(0) < CACHE_FRESH_TTL_MS
}

fn scan_sessions(background: bool) -> RefreshResult {
    let (enter, done, id) = if background {
        ("crsm.background-refresh.enter", "crsm.background-refresh.done", None)
    } else {
        ("crsm.list.enter", "crsm.list.done", Some("refresh"))
    };
    // These existing audit marks describe actual provider scans, not joiners.
    crate::perf_timeline::mark(enter, id);
    let result = list_all_sessions(&ListOptions { refresh: true, use_cache: true })
        .map(|sessions| Arc::new(SessionSnapshot {
            sessions,
            generated_at_ms: chrono::Utc::now().timestamp_millis(),
        }))
        .map_err(|error| error.to_string());
    crate::perf_timeline::mark(done, id);
    result
}

fn read_cached_snapshot() -> Result<Option<Arc<SessionSnapshot>>, String> {
    let home = home_dir().ok_or_else(|| "failed to resolve home directory".to_string())?;
    Ok(read_cached_snapshot_at(&home))
}

fn read_cached_snapshot_at(home: &std::path::Path) -> Option<Arc<SessionSnapshot>> {
    load_cached_sessions(home).map(|mut cache| {
        cache.entries.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        Arc::new(SessionSnapshot {
            sessions: cache.entries,
            generated_at_ms: cache.generated_at.timestamp_millis(),
        })
    })
}

/// Explicit updates always scan or join. Automatic updates recheck freshness,
/// so a background refresh that finished just before the IPC cannot run twice.
fn load_sessions(refresh: bool, automatic: bool) -> RefreshResult {
    load_sessions_with(refresh, automatic, &REFRESHES, read_cached_snapshot, scan_sessions)
}

fn load_sessions_with(
    refresh: bool,
    automatic: bool,
    coordinator: &'static RefreshCoordinator,
    read_cache: impl Fn() -> Result<Option<Arc<SessionSnapshot>>, String>,
    scan: impl Fn(bool) -> RefreshResult + Send + 'static,
) -> RefreshResult {
    if refresh {
        let (flight, leader) = coordinator.claim(None).unwrap();
        return if leader { coordinator.run(&flight, || scan(false)) } else { flight.wait() };
    }
    loop {
        let (generation, _) = coordinator.status();
        let cached = read_cache()?;
        if let Some(snapshot) = &cached {
            if cache_is_fresh(snapshot.generated_at_ms, chrono::Utc::now().timestamp_millis()) {
                return Ok(snapshot.clone());
            }
        }
        let Some((flight, leader)) = coordinator.claim(Some(generation)) else { continue };
        if !automatic {
            if let Some(snapshot) = cached {
                if leader {
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(error) = coordinator.run(&flight, || scan(true)) {
                            eprintln!("[crsm] background session refresh failed: {error}");
                        }
                    });
                }
                return Ok(snapshot);
            }
        }
        return if leader { coordinator.run(&flight, || scan(false)) } else { flight.wait() };
    }
}

/// The same order `crsm list` applies: drop what nobody typed into, then either
/// rank against the query or take the most recent. `--all` has no caller here,
/// so headless and handoff sessions stay hidden.
fn select_sessions(
    mut sessions: Vec<SessionEntry>,
    query: Option<&str>,
    limit: usize,
) -> Vec<SessionEntry> {
    sessions.retain(|entry| entry.has_user_messages);
    match query {
        Some(query) => rank_sessions(&sessions, query, limit),
        None => sessions.into_iter().take(limit).collect(),
    }
}

fn list_sessions_blocking(
    query: Option<String>,
    limit: usize,
    refresh: bool,
    automatic: bool,
) -> Result<Value, String> {
    if !refresh && !automatic {
        crate::perf_timeline::mark("crsm.list.enter", Some("cached"));
    }
    let snapshot = load_sessions(refresh, automatic)?;
    if !refresh && !automatic {
        crate::perf_timeline::mark("crsm.list.done", Some("cached"));
    }
    Ok(serde_json::json!({
        "sessions": select_sessions(snapshot.sessions.clone(), query.as_deref(), limit),
        "cacheGeneratedAtMs": snapshot.generated_at_ms,
        "cacheAgeMs": chrono::Utc::now().timestamp_millis().saturating_sub(snapshot.generated_at_ms).max(0),
        "cacheTtlMs": CACHE_FRESH_TTL_MS,
        "refreshing": REFRESHES.status().1,
    }))
}

/// crsm's own spelling, the one the CLI accepts for `--from` / `--target`.
/// "grok" reaches here from the palette's kind union and has no transcript
/// format, so it comes back named in the error rather than silently ignored.
fn parse_agent_kind(value: &str) -> Result<AgentKind, String> {
    AgentKind::from_str(value.trim())
}

#[tauri::command]
pub async fn crsm_list_sessions(
    query: Option<String>,
    limit: Option<usize>,
    refresh: Option<bool>,
    auto_refresh: Option<bool>,
) -> Result<Value, String> {
    let refresh = refresh.unwrap_or(false);
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT);
    let query = query.filter(|value| !value.trim().is_empty());
    crate::util::task::run_blocking("crsm list", move || {
        list_sessions_blocking(query, limit, refresh, auto_refresh.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn crsm_create_handoff(
    session_id: String,
    from_kind: Option<String>,
    target_kind: String,
    recent_turns: Option<usize>,
) -> Result<Value, String> {
    let from_kind = match from_kind.filter(|value| !value.trim().is_empty()) {
        Some(value) => Some(parse_agent_kind(&value)?),
        None => None,
    };
    let target_kind = parse_agent_kind(&target_kind)?;
    let recent_turns = recent_turns.unwrap_or(DEFAULT_RECENT_TURNS);
    crate::util::task::run_blocking("crsm handoff", move || {
        let result = create_handoff_file(&HandoffRequest {
            session_id,
            from_kind,
            target_kind,
            recent_turns,
        })
        .map_err(|error| error.to_string())?;
        serde_json::to_value(result).map_err(|error| format!("serialize crsm handoff: {error}"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration as ChronoDuration, Utc};
    use std::path::PathBuf;

    fn entry(id: &str, cwd: &str, minutes_ago: i64, has_user_messages: bool) -> SessionEntry {
        SessionEntry {
            kind: AgentKind::Claude,
            id: id.to_string(),
            cwd: cwd.to_string(),
            label: format!("{id} opening prompt"),
            preview: String::new(),
            last_activity: Utc::now() - ChronoDuration::minutes(minutes_ago),
            started_at: None,
            source: "test".to_string(),
            source_path: PathBuf::from("test.jsonl"),
            transcript_path: None,
            summary_file: None,
            files_modified: Vec::new(),
            incomplete_tasks: Vec::new(),
            has_user_messages,
        }
    }

    fn ids(entries: &[SessionEntry]) -> Vec<String> {
        entries.iter().map(|entry| entry.id.clone()).collect()
    }

    #[test]
    fn sessions_nobody_typed_into_stay_out_of_the_list() {
        let sessions = vec![
            entry("typed", "C:/work/alpha", 1, true),
            entry("headless", "C:/work/bravo", 2, false),
        ];
        assert_eq!(ids(&select_sessions(sessions, None, 10)), ["typed"]);
    }

    #[test]
    fn a_query_ranks_instead_of_taking_the_most_recent() {
        let sessions = vec![
            entry("alpha", "C:/work/alpha", 1, true),
            entry("bravo", "C:/work/bravo", 2, true),
            entry("charlie", "C:/work/charlie", 3, true),
        ];
        // Without ranking this would answer alpha (the newest); the query has to
        // reach rank_sessions for bravo to win and the rest to drop out.
        assert_eq!(ids(&select_sessions(sessions, Some("bravo"), 10)), ["bravo"]);
    }

    #[test]
    fn an_empty_list_takes_the_newest_up_to_the_limit() {
        let sessions = vec![
            entry("alpha", "C:/work/alpha", 1, true),
            entry("bravo", "C:/work/bravo", 2, true),
            entry("charlie", "C:/work/charlie", 3, true),
        ];
        assert_eq!(
            ids(&select_sessions(sessions, None, 2)),
            ["alpha", "bravo"]
        );
    }

    /// The frontend reads these field names straight off the command's reply
    /// (`CrsmSessionEntry` in src/lib/ipc.ts), and they are what `crsm list
    /// --json` prints.
    #[test]
    fn entries_serialise_with_the_cli_field_names() {
        let value = serde_json::to_value(vec![entry("alpha", "C:/work/alpha", 1, true)])
            .expect("serialize entries");
        let first = value[0].as_object().expect("entry object");
        let mut keys = first.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "cwd",
                "files_modified",
                "has_user_messages",
                "id",
                "incomplete_tasks",
                "kind",
                "label",
                "last_activity",
                "preview",
                "source",
                "source_path",
                "started_at",
                "summary_file",
                "transcript_path",
            ]
        );
        assert_eq!(first["kind"], serde_json::json!("claude"));
        assert!(first["last_activity"].is_string());
    }

    /// Same contract on the handoff side: `CrsmHandoffResult` in src/lib/ipc.ts
    /// reads these names, and they are what `crsm handoff --json` prints.
    /// crsm-core's own smoke test covers the file this result points at.
    #[test]
    fn handoff_results_serialise_with_the_cli_field_names() {
        let value = serde_json::to_value(crsm_core::HandoffResult {
            path: PathBuf::from("C:/Users/test/.crsm/handoff/20260917T000000Z-claude-to-codex.md"),
            bootstrap_prompt: "Handoff from previous session.".to_string(),
            from_kind: AgentKind::Claude,
            target_kind: AgentKind::Codex,
            from_session_id: "session-a".to_string(),
            cwd: "C:/work/alpha".to_string(),
        })
        .expect("serialize handoff result");
        let result = value.as_object().expect("handoff object");
        let mut keys = result.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "bootstrap_prompt",
                "cwd",
                "from_kind",
                "from_session_id",
                "path",
                "target_kind",
            ]
        );
        assert_eq!(result["from_kind"], serde_json::json!("claude"));
        assert_eq!(result["target_kind"], serde_json::json!("codex"));
    }

    #[test]
    fn a_fresh_cache_is_not_rescanned() {
        assert!(cache_is_fresh(1000, 1000));
        assert!(cache_is_fresh(1000, 999));
        assert!(cache_is_fresh(1000, 1000 + CACHE_FRESH_TTL_MS - 1));
        assert!(!cache_is_fresh(1000, 1000 + CACHE_FRESH_TTL_MS));
    }

    #[test]
    fn missing_invalid_fresh_and_stale_cache_reads_never_scan_providers() {
        use crsm_core::cache::{cache_path, save_cache, CacheFile};
        let home = tempfile::tempdir().unwrap();
        assert!(read_cached_snapshot_at(home.path()).is_none());
        assert!(!cache_path(home.path()).exists(), "a read must not generate a cache");
        let mut cache = CacheFile::empty();
        cache.entries = vec![entry("restored", "C:/work", 1, true)];
        save_cache(home.path(), &cache).unwrap();
        let fresh = read_cached_snapshot_at(home.path()).unwrap();
        assert!(cache_is_fresh(fresh.generated_at_ms, Utc::now().timestamp_millis()));
        cache.generated_at = Utc::now() - ChronoDuration::seconds(120);
        save_cache(home.path(), &cache).unwrap();
        let stale = read_cached_snapshot_at(home.path()).unwrap();
        assert!(!cache_is_fresh(stale.generated_at_ms, Utc::now().timestamp_millis()));
        assert_eq!(stale.generated_at_ms, cache.generated_at.timestamp_millis(), "use embedded age, not fresh file mtime");
        cache.entries.clear();
        cache.generated_at = Utc::now();
        save_cache(home.path(), &cache).unwrap();
        assert!(read_cached_snapshot_at(home.path()).unwrap().sessions.is_empty(), "a refreshed deletion is not hidden by memory caching");
        cache.entries = vec![entry("restored", "C:/work", 1, true)];
        save_cache(home.path(), &cache).unwrap();
        assert_eq!(ids(&read_cached_snapshot_at(home.path()).unwrap().sessions), ["restored"]);
        std::fs::write(cache_path(home.path()), b"invalid cache").unwrap();
        assert!(read_cached_snapshot_at(home.path()).is_none());
    }

    #[test]
    fn missing_cache_scans_once_fresh_cache_does_not_and_failure_can_retry() {
        let coordinator = Box::leak(Box::new(RefreshCoordinator::default()));
        let fresh = load_sessions_with(false, false, coordinator, || Ok(None), |_| {
            Ok(Arc::new(SessionSnapshot { sessions: vec![], generated_at_ms: Utc::now().timestamp_millis() }))
        }).unwrap();
        assert_eq!(coordinator.status(), (1, false));
        let cached = load_sessions_with(false, true, coordinator, || Ok(Some(fresh.clone())), |_| {
            panic!("automatic update of a fresh snapshot must not scan")
        }).unwrap();
        assert!(Arc::ptr_eq(&fresh, &cached));
        assert_eq!(coordinator.status(), (1, false));
        assert!(load_sessions_with(true, false, coordinator, || panic!("explicit refresh must not read cached data"), |_| {
            Err("failed provider".to_string())
        }).is_err());
        assert_eq!(coordinator.status(), (2, false));
        assert!(load_sessions_with(true, false, coordinator, || panic!("explicit refresh must not read cached data"), |_| {
            Ok(Arc::new(SessionSnapshot { sessions: vec![], generated_at_ms: Utc::now().timestamp_millis() }))
        }).is_ok());
        assert_eq!(coordinator.status(), (3, false));
    }

    #[test]
    fn stale_cache_returns_immediately_and_an_automatic_update_joins_the_scan() {
        let coordinator = Box::leak(Box::new(RefreshCoordinator::default()));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let finish_rx = Mutex::new(finish_rx);
        let stale = Arc::new(SessionSnapshot { sessions: vec![], generated_at_ms: 0 });
        let returned = load_sessions_with(false, false, coordinator, || Ok(Some(stale.clone())), move |_| {
            started_tx.send(()).unwrap();
            finish_rx.lock().unwrap().recv().unwrap();
            Ok(Arc::new(SessionSnapshot { sessions: vec![entry("new", "C:/new", 0, true)], generated_at_ms: Utc::now().timestamp_millis() }))
        }).unwrap();
        assert!(Arc::ptr_eq(&stale, &returned));
        started_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        let (joined, leader) = coordinator.claim(None).unwrap();
        assert!(!leader);
        finish_tx.send(()).unwrap();
        let refreshed = joined.wait().unwrap();
        assert_eq!(ids(&refreshed.sessions), ["new"]);
        assert_eq!(coordinator.status(), (1, false));
    }

    #[test]
    fn background_explicit_and_concurrent_queries_share_one_result() {
        let coordinator = RefreshCoordinator::default();
        let (flight, leader) = coordinator.claim(Some(0)).unwrap();
        assert!(leader);
        std::thread::scope(|scope| {
            let waiters: Vec<_> = (0..20).map(|_| {
                let (joined, leader) = coordinator.claim(None).unwrap();
                assert!(!leader);
                assert!(Arc::ptr_eq(&flight, &joined));
                scope.spawn(move || joined.wait().unwrap())
            }).collect();
            let expected = coordinator.run(&flight, || Ok(Arc::new(SessionSnapshot {
                sessions: vec![entry("alpha", "C:/alpha", 1, true), entry("bravo", "C:/bravo", 2, true)],
                generated_at_ms: 1234,
            }))).unwrap();
            for waiter in waiters {
                let received = waiter.join().unwrap();
                assert!(Arc::ptr_eq(&expected, &received));
                assert_eq!(ids(&select_sessions(received.sessions.clone(), Some("bravo"), 1)), ["bravo"]);
            }
        });
        assert_eq!(coordinator.status(), (1, false));
        assert!(coordinator.claim(Some(0)).is_none(), "stale cache reader must reread after completion");
        assert!(coordinator.claim(None).unwrap().1, "a later explicit click still refreshes");
    }

    #[test]
    fn failed_or_panicked_refresh_wakes_waiters_and_allows_retry() {
        for panic in [false, true] {
            let coordinator = RefreshCoordinator::default();
            let (flight, _) = coordinator.claim(None).unwrap();
            let (joined, leader) = coordinator.claim(None).unwrap();
            assert!(!leader);
            assert!(coordinator.run(&flight, || {
                if panic { panic!("synthetic provider failure"); }
                Err("synthetic scan error".to_string())
            }).is_err());
            assert!(joined.wait().is_err());
            assert_eq!(coordinator.status(), (1, false));
            assert!(coordinator.claim(None).unwrap().1);
        }
    }

    #[test]
    fn agent_kinds_use_the_cli_spelling() {
        assert_eq!(parse_agent_kind("claude"), Ok(AgentKind::Claude));
        assert_eq!(parse_agent_kind("codex"), Ok(AgentKind::Codex));
        assert_eq!(parse_agent_kind(" claude-codex "), Ok(AgentKind::ClaudeCodex));
        assert_eq!(
            parse_agent_kind("grok"),
            Err("unknown agent kind: grok".to_string())
        );
    }
}
