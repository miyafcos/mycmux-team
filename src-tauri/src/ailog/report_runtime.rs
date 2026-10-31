//! Independent report lanes and opt-in cancellation, scoped to the real window.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::{Connection, InterruptHandle};
use serde::Deserialize;
use tokio::sync::{Notify, Semaphore};

pub const CANCELLED: &str = "AILOG_REPORT_CANCELLED";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRequest {
    pub id: u64,
    #[serde(default)]
    pub supersedes: Vec<u64>,
    #[serde(default)]
    pub channel: String,
}

#[derive(Clone, Copy)]
pub enum Lane { Light, Heavy }

#[derive(Default)]
struct Signal {
    cancelled: AtomicBool,
    finished: AtomicBool,
    wake: Notify,
    interrupt: Mutex<Option<InterruptHandle>>,
}

impl Signal {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) { Err(CANCELLED.into()) } else { Ok(()) }
    }

    fn cancel(self: &Arc<Self>) {
        if self.cancelled.swap(true, Ordering::AcqRel) { return; }
        self.wake.notify_one();
        // Reissue while the old reader is alive. SQLite can clear an interrupt
        // between statements, and an interrupt before sqlite3_step is a no-op.
        // This closes that race without changing rusqlite features or schema.
        let signal = self.clone();
        std::thread::spawn(move || {
            while !signal.finished.load(Ordering::Acquire) {
                if let Some(handle) = signal.interrupt.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                    handle.interrupt();
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
    }
}

type Key = (String, &'static str, String, u64);

pub struct ReportRuntime {
    light: Arc<Semaphore>,
    heavy: Arc<Semaphore>,
    requests: Mutex<HashMap<Key, Arc<Signal>>>,
}

impl Default for ReportRuntime {
    fn default() -> Self {
        Self { light: Arc::new(Semaphore::new(2)), heavy: Arc::new(Semaphore::new(1)),
            requests: Mutex::new(HashMap::new()) }
    }
}

pub fn runtime() -> &'static ReportRuntime {
    static RUNTIME: OnceLock<ReportRuntime> = OnceLock::new();
    RUNTIME.get_or_init(ReportRuntime::default)
}

struct Registration<'a> {
    owner: &'a ReportRuntime,
    key: Option<Key>,
    signal: Arc<Signal>,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.signal.finished.store(true, Ordering::Release);
        if let Some(key) = &self.key {
            let mut entries = self.owner.requests.lock().unwrap_or_else(|e| e.into_inner());
            if entries.get(key).is_some_and(|entry| Arc::ptr_eq(entry, &self.signal)) { entries.remove(key); }
        }
    }
}

thread_local! {
    static CURRENT: std::cell::RefCell<Option<Arc<Signal>>> = const { std::cell::RefCell::new(None) };
}

/// Cheap cooperative checkpoint for Rust assembly between SQLite statements.
pub(crate) fn checkpoint() -> Result<(), String> {
    CURRENT.with(|current| current.borrow().as_ref().map_or(Ok(()), |signal| signal.check()))
}

impl ReportRuntime {
    fn register(&self, window: &str, endpoint: &'static str, request: Option<ReportRequest>) -> Result<Registration<'_>, String> {
        let signal = Arc::new(Signal::default());
        let mut key = None;
        if let Some(request) = request {
            if request.channel.len() > 128 || request.supersedes.len() > 256 { return Err("invalid report request scope".into()); }
            let mut entries = self.requests.lock().unwrap_or_else(|e| e.into_inner());
            let own = (window.to_string(), endpoint, request.channel.clone(), request.id);
            if entries.contains_key(&own) { return Err("duplicate report request id".into()); }
            // The renderer lists only unshared requests. A shared fetchOnce
            // request is deliberately absent, so its other readers keep it.
            for id in request.supersedes {
                let previous = (window.to_string(), endpoint, request.channel.clone(), id);
                if let Some(previous) = entries.get(&previous) { previous.cancel(); }
            }
            entries.insert(own.clone(), signal.clone());
            key = Some(own);
        }
        Ok(Registration { owner: self, key, signal })
    }

    pub async fn run<T: Send + 'static>(
        &self, window: &str, endpoint: &'static str, request: Option<ReportRequest>, lane: Lane,
        open: impl FnOnce() -> Result<Connection, String> + Send + 'static,
        build: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        self.run_phased(window,endpoint,request,lane,open,None,build).await
    }

    /// A bounded persisted-cache probe precedes the heavy semaphore. Misses
    /// still compute under the production lane and the same cancellation scope.
    pub async fn run_with_probe<T: Send + 'static>(
        &self, window: &str, endpoint: &'static str, request: Option<ReportRequest>, lane: Lane,
        open: impl FnOnce() -> Result<Connection, String> + Send + 'static,
        probe: impl FnOnce(&Connection) -> Result<Option<T>, String> + Send + 'static,
        build: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        self.run_phased(window,endpoint,request,lane,open,Some(Box::new(probe)),build).await
    }

    async fn run_phased<T: Send + 'static>(
        &self, window: &str, endpoint: &'static str, request: Option<ReportRequest>, lane: Lane,
        open: impl FnOnce() -> Result<Connection, String> + Send + 'static,
        probe: Option<Box<dyn FnOnce(&Connection) -> Result<Option<T>, String> + Send>>,
        build: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let registration = self.register(window, endpoint, request)?;
        let signal = registration.signal.clone();
        let mut open=Some(open);
        let preopened=if let Some(probe)=probe {
            let open=open.take().unwrap();
            let worker_signal=signal.clone();
            let probed=tokio::task::spawn_blocking(move || -> Result<_,String> {
                worker_signal.check()?;
                let conn=open()?;
                *worker_signal.interrupt.lock().unwrap_or_else(|e|e.into_inner())=Some(conn.get_interrupt_handle());
                worker_signal.check()?;
                let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
                let saved=probe(&conn)?;
                worker_signal.check()?;
                tx.commit().map_err(|e|e.to_string())?;
                Ok((conn,saved))
            }).await.map_err(|e|format!("report cache probe failed: {e}"))?;
            signal.check()?;
            let (conn,saved)=probed?;
            if let Some(saved)=saved { return Ok(saved); }
            Some(conn)
        } else { None };
        let gate = match lane { Lane::Light => &self.light, Lane::Heavy => &self.heavy };
        let permit = tokio::select! {
            biased;
            _ = signal.wake.notified() => return Err(CANCELLED.into()),
            permit = gate.clone().acquire_owned() => permit.map_err(|error| format!("report gate closed: {error}"))?,
        };
        signal.check()?;
        let worker_signal = signal.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            worker_signal.check()?;
            let conn = match preopened { Some(conn)=>conn,None=>open.take().unwrap()()? };
            *worker_signal.interrupt.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn.get_interrupt_handle());
            worker_signal.check()?;
            CURRENT.with(|current| *current.borrow_mut() = Some(worker_signal.clone()));
            struct CurrentGuard;
            impl Drop for CurrentGuard {
                fn drop(&mut self) { CURRENT.with(|current| *current.borrow_mut() = None); }
            }
            let _current = CurrentGuard;
            // Every statement observes one committed view, even for old callers
            // that do not opt into the persisted report cache.
            let tx = conn.unchecked_transaction().map_err(|error| error.to_string())?;
            let result = build(&conn);
            worker_signal.check()?;
            tx.commit().map_err(|error| error.to_string())?;
            result
        }).await.map_err(|error| format!("report worker task failed: {error}"))?;
        signal.check()?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn memory() -> Result<Connection, String> { Connection::open_in_memory().map_err(|error| error.to_string()) }
    fn request(id: u64, supersedes: Vec<u64>) -> Option<ReportRequest> {
        Some(ReportRequest { id, supersedes, channel: "report".into() })
    }

    #[tokio::test]
    async fn light_reports_do_not_wait_for_a_slow_heavy_report() {
        let runtime = Arc::new(ReportRuntime::default());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (finish, wait) = std::sync::mpsc::channel();
        let owner = runtime.clone();
        let heavy = tokio::spawn(async move { owner.run("main", "heavy", None, Lane::Heavy, memory, move |_| {
            started.send(()).unwrap(); wait.recv().unwrap(); Ok(())
        }).await });
        ready.await.unwrap();
        let (finish_second, wait_second) = std::sync::mpsc::channel();
        let second_owner=runtime.clone();
        let second=tokio::spawn(async move { second_owner.run("main","heavy2",None,Lane::Heavy,memory,move |_| {
            wait_second.recv().unwrap(); Ok(())
        }).await });
        tokio::time::sleep(Duration::from_millis(25)).await;
        let light = tokio::time::timeout(Duration::from_millis(100), runtime.run("main", "light", None, Lane::Light, memory, |_| Ok(7))).await;
        finish.send(()).unwrap(); finish_second.send(()).unwrap();
        heavy.await.unwrap().unwrap(); second.await.unwrap().unwrap();
        assert_eq!(light.unwrap().unwrap(), 7);
    }

    #[tokio::test]
    async fn superseded_waiter_never_opens_a_reader() {
        let runtime = Arc::new(ReportRuntime::default());
        let permit = runtime.heavy.clone().acquire_owned().await.unwrap();
        let opened = Arc::new(AtomicBool::new(false));
        let flag = opened.clone(); let owner = runtime.clone();
        let old = tokio::spawn(async move { owner.run("main", "heavy", request(1, vec![]), Lane::Heavy,
            move || { flag.store(true, Ordering::Release); memory() }, |_| Ok(())).await });
        while runtime.requests.lock().unwrap().is_empty() { tokio::task::yield_now().await; }
        let next = runtime.register("main", "heavy", request(2, vec![1])).unwrap();
        assert_eq!(old.await.unwrap().unwrap_err(), CANCELLED);
        assert!(!opened.load(Ordering::Acquire));
        drop(next); drop(permit);
    }

    #[tokio::test]
    async fn running_sql_releases_its_lane_within_200ms_when_superseded() {
        let runtime = Arc::new(ReportRuntime::default());
        let (started, ready) = tokio::sync::oneshot::channel();
        let owner = runtime.clone();
        let old = tokio::spawn(async move { owner.run("main", "heavy", request(1, vec![]), Lane::Heavy, memory, move |conn| {
            started.send(()).unwrap();
            conn.query_row("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT SUM(x) FROM n", [], |row| row.get::<_, i64>(0)).map_err(|error| error.to_string())
        }).await });
        ready.await.unwrap();
        let begin = Instant::now();
        runtime.run("main", "heavy", request(2, vec![1]), Lane::Heavy, memory, |_| Ok(())).await.unwrap();
        assert!(begin.elapsed() < Duration::from_millis(200));
        assert_eq!(old.await.unwrap().unwrap_err(), CANCELLED);
    }

    #[test]
    fn cancellation_stays_in_window_endpoint_channel_and_preserves_shared_readers() {
        let runtime = ReportRuntime::default();
        let old = runtime.register("main", "heavy", request(1, vec![])).unwrap();
        let other_window = runtime.register("detached", "heavy", request(2, vec![1])).unwrap();
        let other_endpoint = runtime.register("main", "light", request(3, vec![1])).unwrap();
        let shared = runtime.register("main", "heavy", request(4, vec![])).unwrap();
        assert!(old.signal.check().is_ok());
        drop((other_window, other_endpoint, shared));
        let new = runtime.register("main", "heavy", request(5, vec![1])).unwrap();
        assert_eq!(old.signal.check().unwrap_err(), CANCELLED);
        drop((new, old));
        assert!(runtime.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn legacy_calls_without_request_metadata_still_run() {
        assert_eq!(ReportRuntime::default().run("", "old", None, Lane::Heavy, memory, |_| Ok(9)).await.unwrap(), 9);
    }

    #[tokio::test]
    async fn interrupted_cache_probe_returns_cancellation_marker_instead_of_sqlite_error() {
        let runtime=Arc::new(ReportRuntime::default());
        let owner=runtime.clone();
        let (started,ready)=tokio::sync::oneshot::channel();
        let old=tokio::spawn(async move { owner.run_with_probe("main","cached",request(1,vec![]),Lane::Heavy,memory,
            move |conn| {
                started.send(()).unwrap();
                conn.query_row("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT SUM(x) FROM n",[],|r|r.get::<_,i64>(0))
                    .map(Some).map_err(|e|e.to_string())
            },|_|Ok(0_i64)).await });
        ready.await.unwrap();
        runtime.run("main","cached",request(2,vec![1]),Lane::Heavy,memory,|_|Ok(0_i64)).await.unwrap();
        assert_eq!(old.await.unwrap().unwrap_err(),CANCELLED);
    }
}
