//! Freeze diagnostics. The UI callbacks only stamp atomics or enqueue a line;
//! the dedicated thread owns RAM sampling and disk I/O. Each layer has at most
//! one outstanding probe, including while that layer is stalled.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

static CLOCK: OnceLock<Instant> = OnceLock::new();
static LOG_QUEUE: OnceLock<SyncSender<String>> = OnceLock::new();
static FAILURES: OnceLock<SyncSender<RendererFailure>> = OnceLock::new();
static MAIN_CREATION: OnceLock<Instant> = OnceLock::new();
static RENDERER: OnceLock<Mutex<RendererWatch>> = OnceLock::new();

fn clock_ms() -> u64 {
    CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn renderer() -> &'static Mutex<RendererWatch> {
    RENDERER.get_or_init(|| Mutex::new(RendererWatch::new(clock_ms())))
}

/// Nonblocking even on a WebView2 callback. The queue is bounded so diagnostic
/// failures cannot create an unbounded backlog during a freeze.
pub(crate) fn log_with_memory(line: String) {
    if let Some(queue) = LOG_QUEUE.get() {
        let _ = queue.try_send(line);
    }
}

const RELOAD_WINDOW_MS: u64 = 600_000;
const RELOAD_SPACING_MS: u64 = 60_000;
const MAX_RELOADS: usize = 3;

struct RendererFailure {
    webview: String,
    kind: i32,
}

/// Only enqueue from the COM callback: rebuilding a view there can deadlock
/// the window event loop. The watchdog thread dispatches the actual reload.
#[cfg(windows)]
fn queue_renderer_failure(webview: String, kind: i32) {
    if let Some(queue) = FAILURES.get() {
        if queue.try_send(RendererFailure { webview, kind }).is_err() {
            log_with_memory("[webview2] recovery queue full; reload not scheduled".to_string());
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RecoveryDecision {
    Reload { attempt: usize, kind: i32 },
    GiveUp { kind: i32 },
}

#[derive(Default)]
pub(crate) struct ReloadBudget {
    attempts: VecDeque<u64>,
    pending: Option<i32>,
    gave_up: bool,
}

impl ReloadBudget {
    pub(crate) fn failed(&mut self, kind: i32) {
        self.pending = Some(kind);
    }

    pub(crate) fn poll(&mut self, now_ms: u64) -> Option<RecoveryDecision> {
        let kind = self.pending?;
        while self.attempts.front().is_some_and(|at| now_ms.saturating_sub(*at) >= RELOAD_WINDOW_MS) {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= MAX_RELOADS {
            self.pending = None;
            return if std::mem::replace(&mut self.gave_up, true) {
                None
            } else {
                Some(RecoveryDecision::GiveUp { kind })
            };
        }
        if self.attempts.back().is_some_and(|at| now_ms.saturating_sub(*at) < RELOAD_SPACING_MS) {
            // Keep one pending failure so an early crash gets a delayed retry.
            return None;
        }
        self.pending = None;
        self.gave_up = false;
        self.attempts.push_back(now_ms);
        Some(RecoveryDecision::Reload { attempt: self.attempts.len(), kind })
    }
}

fn recover_renderers(
    app: &AppHandle,
    budgets: &mut HashMap<String, ReloadBudget>,
    failures: impl Iterator<Item = RendererFailure>,
    now_ms: u64,
    lines: &mut Vec<String>,
) {
    for failure in failures {
        if app.get_webview(&failure.webview).is_some() {
            budgets.entry(failure.webview).or_default().failed(failure.kind);
        }
    }
    budgets.retain(|label, _| app.get_webview(label).is_some());
    for (label, budget) in budgets.iter_mut() {
        match budget.poll(now_ms) {
            Some(RecoveryDecision::Reload { attempt, kind }) => {
                if let Some(webview) = app.get_webview(label) {
                    // No PTY operation: the reloaded frontend reattaches by ID.
                    let result = webview.reload();
                    lines.push(format!(
                        "[webview2] renderer reload webview={label} kind={kind} attempt={attempt}/{MAX_RELOADS} success={} error={:?}",
                        result.is_ok(), result.err().map(|error| error.to_string())
                    ));
                }
            }
            Some(RecoveryDecision::GiveUp { kind }) => lines.push(format!(
                "[webview2] renderer recovery give up webview={label} kind={kind} limit={MAX_RELOADS}/10min"
            )),
            None => {}
        }
    }
}

pub(crate) fn begin_main_webview_creation() {
    let _ = MAIN_CREATION.set(Instant::now());
}

pub(crate) fn main_webview_created() {
    if let Some(start) = MAIN_CREATION.get() {
        record_webview_creation("main", "main", start.elapsed(), true);
    }
}

fn creation_line(window: &str, webview: &str, elapsed: Duration, success: bool) -> String {
    let warning = if elapsed > Duration::from_secs(10) { " WARN slow creation" } else { "" };
    format!("[webview2] creation window={window} webview={webview} elapsed_ms={} success={success}{warning}", elapsed.as_millis())
}

pub(crate) fn record_webview_creation(window: &str, webview: &str, elapsed: Duration, success: bool) {
    log_with_memory(creation_line(window, webview, elapsed, success));
}

#[derive(Default)]
pub(crate) struct RateLimit {
    last: Option<Instant>,
}

impl RateLimit {
    pub(crate) fn allow_at(&mut self, now: Instant) -> bool {
        if self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) < Duration::from_secs(60))
        {
            return false;
        }
        self.last = Some(now);
        true
    }
}

#[derive(Default)]
pub(crate) struct OutputDropLog {
    since: Option<Instant>,
    reported: bool,
    limit: RateLimit,
}

impl OutputDropLog {
    pub(crate) fn transition(&mut self, dropping: bool, now: Instant) -> Option<String> {
        if dropping {
            if self.since.is_none() {
                self.since = Some(now);
                self.reported = self.limit.allow_at(now);
                if self.reported {
                    return Some("frontend drop enter".to_string());
                }
            }
        } else if let Some(since) = self.since.take() {
            if std::mem::take(&mut self.reported) {
                return Some(format!(
                    "frontend drop exit after_ms={}",
                    now.saturating_duration_since(since).as_millis()
                ));
            }
        }
        None
    }
}

struct DelayWatch {
    threshold_ms: u64,
    announced: bool,
}

impl DelayWatch {
    fn new(threshold_ms: u64) -> Self {
        Self {
            threshold_ms,
            announced: false,
        }
    }

    fn pending(&mut self, layer: &str, delay_ms: u64) -> Option<String> {
        if delay_ms >= self.threshold_ms && !self.announced {
            self.announced = true;
            return Some(format!("[watchdog] {layer} late {delay_ms}ms"));
        }
        None
    }

    fn completed(&mut self, layer: &str, delay_ms: u64) -> Vec<String> {
        let mut lines: Vec<_> = self.pending(layer, delay_ms).into_iter().collect();
        if std::mem::take(&mut self.announced) {
            lines.push(format!("[watchdog] {layer} back after {delay_ms}ms"));
        }
        lines
    }
}

#[derive(Default)]
struct ProbeStamp {
    finished: AtomicBool,
    completed_ms: AtomicU64,
}

impl ProbeStamp {
    fn complete_at(&self, now_ms: u64) {
        self.completed_ms.store(now_ms, Ordering::Release);
        self.finished.store(true, Ordering::Release);
    }

    fn complete(&self) {
        self.complete_at(clock_ms());
    }
}

struct Probe {
    stamp: Arc<ProbeStamp>,
    since_ms: Option<u64>,
    outstanding: bool,
    delay: DelayWatch,
}

impl Probe {
    fn new(threshold_ms: u64) -> Self {
        Self {
            stamp: Arc::new(ProbeStamp::default()),
            since_ms: None,
            outstanding: false,
            delay: DelayWatch::new(threshold_ms),
        }
    }

    fn prepare(&mut self, now_ms: u64) -> Option<Arc<ProbeStamp>> {
        if self.outstanding {
            return None;
        }
        self.outstanding = true;
        self.since_ms.get_or_insert(now_ms);
        Some(self.stamp.clone())
    }

    fn poll(&mut self, layer: &str, now_ms: u64, lines: &mut Vec<String>) {
        let Some(since_ms) = self.since_ms else {
            return;
        };
        if self.stamp.finished.swap(false, Ordering::AcqRel) {
            let delay_ms = self
                .stamp
                .completed_ms
                .load(Ordering::Acquire)
                .saturating_sub(since_ms);
            lines.extend(self.delay.completed(layer, delay_ms));
            self.since_ms = None;
            self.outstanding = false;
        } else if let Some(line) = self.delay.pending(layer, now_ms.saturating_sub(since_ms)) {
            lines.push(line);
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererHeartbeat {
    pub heap_used_mib: Option<f64>,
    pub long_tasks: u32,
    pub max_long_task_ms: f64,
    pub xterm_count: u32,
    pub pending_invokes: u32,
    pub visibility: String,
    pub focus: bool,
}

struct RendererWatch {
    last_seen_ms: u64,
    silent: bool,
    last_sample_ms: Option<u64>,
    last_long_sample_ms: Option<u64>,
}

impl RendererWatch {
    fn new(now_ms: u64) -> Self {
        Self {
            last_seen_ms: now_ms,
            silent: false,
            last_sample_ms: None,
            last_long_sample_ms: None,
        }
    }

    fn poll(&mut self, now_ms: u64) -> Option<String> {
        if !self.silent && now_ms.saturating_sub(self.last_seen_ms) >= 120_000 {
            self.silent = true;
            return Some("[watchdog] renderer silent".to_string());
        }
        None
    }

    fn heartbeat(&mut self, heartbeat: &RendererHeartbeat, now_ms: u64) -> Vec<String> {
        let mut lines = Vec::new();
        if std::mem::take(&mut self.silent) {
            lines.push(format!(
                "[watchdog] renderer back after {}s",
                now_ms.saturating_sub(self.last_seen_ms) / 1000
            ));
        }
        self.last_seen_ms = now_ms;
        let periodic = self
            .last_sample_ms
            .map_or(true, |at| now_ms.saturating_sub(at) >= 600_000);
        let long_task = heartbeat.max_long_task_ms >= 1000.0
            && self
                .last_long_sample_ms
                .map_or(true, |at| now_ms.saturating_sub(at) >= 30_000);
        if periodic || long_task {
            let heap = heartbeat
                .heap_used_mib
                .map_or_else(|| "unknown".to_string(), |mib| format!("{mib:.1}"));
            let visibility = match heartbeat.visibility.as_str() {
                "visible" | "hidden" | "prerender" => heartbeat.visibility.as_str(),
                _ => "unknown",
            };
            lines.push(format!(
                "[renderer] heap_used_mib={heap} longtasks={} max_longtask_ms={:.1} xterm={} pending_invokes={} visibility={visibility} focus={}",
                heartbeat.long_tasks, heartbeat.max_long_task_ms, heartbeat.xterm_count, heartbeat.pending_invokes, heartbeat.focus
            ));
            self.last_sample_ms = Some(now_ms);
            if long_task {
                self.last_long_sample_ms = Some(now_ms);
            }
        }
        lines
    }
}

#[tauri::command]
pub async fn report_renderer_heartbeat(heartbeat: RendererHeartbeat) -> Result<(), String> {
    if heartbeat
        .heap_used_mib
        .is_some_and(|value| !value.is_finite() || value < 0.0)
        || !heartbeat.max_long_task_ms.is_finite()
        || heartbeat.max_long_task_ms < 0.0
    {
        return Err("invalid renderer heartbeat measurements".to_string());
    }
    let lines = renderer()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .heartbeat(&heartbeat, clock_ms());
    for line in lines {
        log_with_memory(line);
    }
    Ok(())
}

// Register this instead of terminal::kill_session solely to time the entire
// command, including the queued hook drain, ConPTY teardown and file cleanup.
// The command itself moves blocking work to the blocking pool.
#[tauri::command]
pub async fn measured_kill_session(
    state: State<'_, crate::AppState>,
    session_id: String,
) -> Result<(), String> {
    static LIMITS: OnceLock<Mutex<(RateLimit, RateLimit)>> = OnceLock::new();
    let start = Instant::now();
    let result = crate::commands::terminal::kill_session(state, session_id.clone()).await;
    let elapsed_ms = start.elapsed().as_millis();
    let should_log = {
        let mut limits = LIMITS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let limit = if elapsed_ms >= 1000 || result.is_err() {
            &mut limits.1
        } else {
            &mut limits.0
        };
        limit.allow_at(Instant::now())
    };
    if should_log {
        log_with_memory(format!(
            "[pty] kill_session session={session_id} elapsed_ms={elapsed_ms} success={}",
            result.is_ok()
        ));
    }
    result
}

// Tauri exports command macros at crate scope, so the measuring wrapper
// needs a unique Rust name. The handler aliases preserve the public IPC name.
pub(crate) use __cmd__measured_kill_session as __cmd__kill_session;
pub(crate) use measured_kill_session as kill_session;

pub(crate) fn start(app: AppHandle) {
    let (queue, receiver) = mpsc::sync_channel(128);
    if LOG_QUEUE.set(queue).is_err() {
        return;
    }
    let (failure_queue, failure_receiver) = mpsc::sync_channel(128);
    let _ = FAILURES.set(failure_queue);
    let _ = renderer();
    if let Err(error) = std::thread::Builder::new()
        .name("mycmux-watchdog".to_string())
        .spawn(move || {
            let mut recoveries = HashMap::new();
            let mut main = Probe::new(3000);
            let mut runtime = Probe::new(2000);
            let mut blocking = Probe::new(2000);
            let mut post_error_log = RateLimit::default();
            loop {
                let now_ms = clock_ms();
                let mut lines = Vec::new();
                main.poll("main thread", now_ms, &mut lines);
                runtime.poll("tokio", now_ms, &mut lines);
                blocking.poll("blocking pool", now_ms, &mut lines);
                if let Some(line) = renderer()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .poll(now_ms)
                {
                    lines.push(line);
                }
                recover_renderers(&app, &mut recoveries, failure_receiver.try_iter(), now_ms, &mut lines);
                lines.extend(receiver.try_iter());
                if !lines.is_empty() {
                    let ram =
                        free_ram_mib().map_or_else(|| "unknown".to_string(), |mib| mib.to_string());
                    for line in lines {
                        crate::diag::log(&format!("{line} free_ram_mib={ram}"));
                    }
                }
                if let Some(stamp) = main.prepare(clock_ms()) {
                    let callback_stamp = stamp.clone();
                    if let Err(error) = app.run_on_main_thread(move || callback_stamp.complete()) {
                        // Retry a failed post next tick without forgetting how long
                        // it has been since the first unanswered probe.
                        main.outstanding = false;
                        if post_error_log.allow_at(Instant::now()) {
                            log_with_memory(format!(
                                "[watchdog] main thread probe post failed: {error}"
                            ));
                        }
                    }
                }
                if let Some(stamp) = runtime.prepare(clock_ms()) {
                    tauri::async_runtime::spawn(async move {
                        stamp.complete();
                    });
                }
                if let Some(stamp) = blocking.prepare(clock_ms()) {
                    tauri::async_runtime::spawn_blocking(move || stamp.complete());
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        })
    {
        tauri::async_runtime::spawn_blocking(move || {
            crate::diag::warn("watchdog", &format!("failed to start: {error}"));
        });
    }
}

#[cfg(windows)]
fn free_ram_mib() -> Option<u64> {
    // The existing windows feature set does not include SystemInformation.
    // This stable kernel32 ABI avoids adding a dependency or feature.
    #[repr(C)]
    #[derive(Default)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        ..Default::default()
    };
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        None
    } else {
        Some(status.avail_phys / (1024 * 1024))
    }
}

#[cfg(not(windows))]
fn free_ram_mib() -> Option<u64> {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    Some(system.available_memory() / (1024 * 1024))
}

#[cfg(windows)]
pub(crate) fn register_process_failed(webview: &tauri::Webview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_webview2::core::Interface;

    let label = format!(
        "window={} webview={}",
        webview.window().label(),
        webview.label()
    );
    let webview_label = webview.label().to_string();
    let posted_label = label.clone();
    if let Err(error) = webview.with_webview(move |platform| {
        let event_label = posted_label.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let mut kind = None;
            let mut exit_code = None;
            if let Some(args) = args {
                let mut raw_kind = COREWEBVIEW2_PROCESS_FAILED_KIND(-1);
                if unsafe { args.ProcessFailedKind(&mut raw_kind) }.is_ok() {
                    kind = Some(raw_kind.0);
                }
                if let Ok(args) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                    let mut code = 0;
                    if unsafe { args.ExitCode(&mut code) }.is_ok() {
                        exit_code = Some(code);
                    }
                }
            }
            log_with_memory(format!(
                "[webview2] ProcessFailed kind={kind:?} exit_code={exit_code:?} {event_label}"
            ));
            if let Some(kind) = kind.filter(|kind| {
                *kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED.0
                    || *kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE.0
                    || *kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED.0
            }) {
                queue_renderer_failure(webview_label.clone(), kind);
            }
            Ok(())
        }));
        let mut token = 0;
        let registered = unsafe {
            platform
                .controller()
                .CoreWebView2()
                .and_then(|core| core.add_ProcessFailed(&handler, &mut token))
        };
        if let Err(error) = registered {
            log_with_memory(format!(
                "[webview2] ProcessFailed registration failed {posted_label}: {error}"
            ));
        }
        // CoreWebView2 owns the handler until the view is destroyed.
    }) {
        log_with_memory(format!(
            "[webview2] ProcessFailed registration post failed {label}: {error}"
        ));
    }
}

#[cfg(not(windows))]
pub(crate) fn register_process_failed(_webview: &tauri::Webview) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_budget_keeps_early_failures_and_stops_after_three_attempts() {
        let mut budget = ReloadBudget::default();
        budget.failed(1);
        assert_eq!(budget.poll(0), Some(RecoveryDecision::Reload { attempt: 1, kind: 1 }));
        assert!(budget.poll(1).is_none());
        budget.failed(2);
        for at in [1, 10_000, 59_999] {
            assert!(budget.poll(at).is_none());
        }
        assert_eq!(budget.poll(60_000), Some(RecoveryDecision::Reload { attempt: 2, kind: 2 }));
        budget.failed(1);
        assert!(budget.poll(119_999).is_none());
        assert_eq!(budget.poll(120_000), Some(RecoveryDecision::Reload { attempt: 3, kind: 1 }));
        budget.failed(2);
        assert_eq!(budget.poll(120_001), Some(RecoveryDecision::GiveUp { kind: 2 }));
        for at in [180_000, 599_999] {
            budget.failed(1);
            assert!(budget.poll(at).is_none());
        }
        assert!(budget.poll(600_000).is_none()); // No unsolicited retry after give-up.
        budget.failed(2);
        assert_eq!(budget.poll(600_000), Some(RecoveryDecision::Reload { attempt: 3, kind: 2 }));
        assert_eq!(budget.attempts.len(), 3);
    }

    #[test]
    fn reload_budgets_are_independent_for_each_webview() {
        let mut budgets = HashMap::<String, ReloadBudget>::new();
        for label in ["main", "child", "web-pane"] {
            let budget = budgets.entry(label.to_string()).or_default();
            budget.failed(1);
            assert_eq!(budget.poll(0), Some(RecoveryDecision::Reload { attempt: 1, kind: 1 }));
        }
        budgets.get_mut("main").unwrap().failed(2);
        assert!(budgets.get_mut("main").unwrap().poll(1).is_none());
        assert!(budgets.get_mut("child").unwrap().poll(60_000).is_none());
    }

    #[test]
    fn webview_creation_records_success_failure_and_warns_only_over_ten_seconds() {
        let normal = creation_line("child", "pane", Duration::from_secs(10), true);
        assert!(normal.contains("elapsed_ms=10000 success=true"));
        assert!(!normal.contains("WARN"));
        let slow = creation_line("child", "pane", Duration::from_millis(10_001), false);
        assert!(slow.contains("elapsed_ms=10001 success=false WARN slow creation"));
    }

    fn heartbeat() -> RendererHeartbeat {
        RendererHeartbeat {
            heap_used_mib: Some(64.0),
            long_tasks: 0,
            max_long_task_ms: 0.0,
            xterm_count: 3,
            pending_invokes: 1,
            visibility: "visible".to_string(),
            focus: true,
        }
    }

    #[test]
    fn delayed_layers_log_once_and_recovery_reports_the_whole_delay() {
        for (layer, threshold) in [
            ("main thread", 3000),
            ("tokio", 2000),
            ("blocking pool", 2000),
        ] {
            let mut watch = DelayWatch::new(threshold);
            assert!(watch.pending(layer, threshold - 1).is_none());
            assert_eq!(
                watch.pending(layer, threshold).unwrap(),
                format!("[watchdog] {layer} late {threshold}ms")
            );
            assert!(watch.pending(layer, threshold + 1000).is_none());
            assert_eq!(
                watch.completed(layer, 5000),
                vec![format!("[watchdog] {layer} back after 5000ms")]
            );
            assert!(watch.completed(layer, 1).is_empty());
        }
    }

    #[test]
    fn a_probe_never_accumulates_callbacks_and_uses_the_completion_time() {
        let mut probe = Probe::new(3000);
        let stamp = probe.prepare(0).unwrap();
        let mut lines = Vec::new();
        for second in 1..=5 {
            probe.poll("main thread", second * 1000, &mut lines);
            assert!(probe.prepare(second * 1000).is_none());
        }
        assert_eq!(lines, vec!["[watchdog] main thread late 3000ms"]);
        stamp.complete_at(5500);
        probe.poll("main thread", 6000, &mut lines);
        assert_eq!(lines[1], "[watchdog] main thread back after 5500ms");
        assert!(probe.prepare(6000).is_some());
    }

    #[test]
    fn a_failed_main_thread_post_is_retried_without_resetting_the_delay() {
        let mut probe = Probe::new(3000);
        probe.prepare(0).unwrap();
        probe.outstanding = false;
        assert!(probe.prepare(1000).is_some());
        let mut lines = Vec::new();
        probe.poll("main thread", 3000, &mut lines);
        assert_eq!(lines, vec!["[watchdog] main thread late 3000ms"]);
    }

    #[test]
    fn healthy_probes_write_nothing_even_after_many_ticks() {
        let mut probe = Probe::new(2000);
        let mut lines = Vec::new();
        for second in 0..1000 {
            probe
                .prepare(second * 1000)
                .unwrap()
                .complete_at(second * 1000 + 1);
            probe.poll("tokio", second * 1000 + 100, &mut lines);
        }
        assert!(lines.is_empty());
    }

    #[test]
    fn a_renderer_is_silent_after_two_minutes_and_logs_its_return_once() {
        let mut watch = RendererWatch::new(0);
        assert!(watch.poll(119_999).is_none());
        assert_eq!(watch.poll(120_000).unwrap(), "[watchdog] renderer silent");
        assert!(watch.poll(130_000).is_none());
        let lines = watch.heartbeat(&heartbeat(), 135_000);
        assert_eq!(lines[0], "[watchdog] renderer back after 135s");
        assert_eq!(lines.len(), 2);
        assert!(watch.heartbeat(&heartbeat(), 165_000).is_empty());
        assert!(watch.poll(284_999).is_none());
        assert!(watch.poll(285_000).is_some());
    }

    #[test]
    fn renderer_metrics_are_periodic_or_long_and_are_rate_limited() {
        let mut watch = RendererWatch::new(0);
        let mut sample = heartbeat();
        assert_eq!(watch.heartbeat(&sample, 0).len(), 1);
        for now in (30_000..600_000).step_by(30_000) {
            assert!(watch.heartbeat(&sample, now).is_empty());
        }
        assert_eq!(watch.heartbeat(&sample, 600_000).len(), 1);
        sample.max_long_task_ms = 1000.0;
        assert_eq!(watch.heartbeat(&sample, 630_000).len(), 1);
        assert!(watch.heartbeat(&sample, 630_001).is_empty());
        assert_eq!(watch.heartbeat(&sample, 660_000).len(), 1);
    }

    #[test]
    fn renderer_heartbeat_uses_the_shared_camel_case_schema() {
        let json = serde_json::to_value(heartbeat()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "heapUsedMib": 64.0, "longTasks": 0,
            "maxLongTaskMs": 0.0, "xtermCount": 3, "pendingInvokes": 1,
            "visibility": "visible", "focus": true })
        );
        let parsed: RendererHeartbeat = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.xterm_count, 3);
    }

    #[test]
    fn error_and_drop_logs_are_first_then_once_a_minute_with_paired_recovery() {
        let now = Instant::now();
        let mut limit = RateLimit::default();
        assert!(limit.allow_at(now));
        assert!(!limit.allow_at(now + Duration::from_secs(59)));
        assert!(limit.allow_at(now + Duration::from_secs(60)));
        let mut drop = OutputDropLog::default();
        assert!(drop.transition(false, now).is_none());
        assert_eq!(drop.transition(true, now).unwrap(), "frontend drop enter");
        assert!(drop
            .transition(true, now + Duration::from_secs(2))
            .is_none());
        assert_eq!(
            drop.transition(false, now + Duration::from_secs(5))
                .unwrap(),
            "frontend drop exit after_ms=5000"
        );
        assert!(drop
            .transition(true, now + Duration::from_secs(10))
            .is_none());
        assert!(drop
            .transition(false, now + Duration::from_secs(11))
            .is_none());
        assert!(drop
            .transition(true, now + Duration::from_secs(60))
            .is_some());
    }
}
