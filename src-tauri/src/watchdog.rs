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
static LOG_QUEUE: OnceLock<SyncSender<(String, u64)>> = OnceLock::new();
static DROPPED_LOG_LINES: AtomicU64 = AtomicU64::new(0);
static FAILURES: OnceLock<SyncSender<RendererFailure>> = OnceLock::new();
static MAIN_CREATION: OnceLock<Instant> = OnceLock::new();
static RENDERERS: OnceLock<Mutex<RendererWatches>> = OnceLock::new();

fn clock_ms() -> u64 {
    CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64
}

// Renderer silence measures awake time. Sleep does not consume a heartbeat deadline.
#[cfg(windows)]
fn renderer_clock_ms() -> u64 {
    #[link(name = "kernel32")]
    extern "system" {
        fn QueryUnbiasedInterruptTime(unbiased_time: *mut u64) -> i32;
    }
    let mut ticks = 0;
    // SAFETY: Windows writes one u64 to this valid out parameter.
    if unsafe { QueryUnbiasedInterruptTime(&mut ticks) } != 0 {
        ticks / 10_000
    } else {
        clock_ms()
    }
}

#[cfg(target_os = "macos")]
fn renderer_clock_ms() -> u64 {
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: this writes to the supplied timespec for a supported clock.
    if unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &mut now) } == 0 {
        now.tv_sec as u64 * 1_000 + now.tv_nsec as u64 / 1_000_000
    } else {
        clock_ms()
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn renderer_clock_ms() -> u64 {
    clock_ms()
}

fn renderers() -> &'static Mutex<RendererWatches> {
    RENDERERS.get_or_init(|| Mutex::new(RendererWatches::default()))
}

/// Nonblocking even on a WebView2 callback. The queue is bounded so diagnostic
/// failures cannot create an unbounded backlog during a freeze.
fn format_with_memory(line: &str, ram: &str) -> String {
    if let Some((prefix, metadata)) = line.split_once(" |diag-meta| ") {
        format!("{prefix} free_ram_mib={ram} {metadata}")
    } else { format!("{line} free_ram_mib={ram}") }
}

fn enqueue_log_with_drop_count(queue: &SyncSender<(String, u64)>, dropped: &AtomicU64, line: String) {
    let count = dropped.swap(0, Ordering::Relaxed);
    let line = (line, count);
    if queue.try_send(line).is_err() {
        dropped.fetch_add(count.saturating_add(1), Ordering::Relaxed);
    }
}

pub(crate) fn log_with_memory(line: String) {
    if let Some(queue) = LOG_QUEUE.get() {
        enqueue_log_with_drop_count(queue, &DROPPED_LOG_LINES, line);
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

fn reload_renderer<T>(
    registry: Option<&crate::window_registry::WindowRegistry>,
    webview_label: &str,
    window_label: &str,
    reload: impl FnOnce() -> T,
) -> T {
    if webview_label == window_label {
        if let Some(registry) = registry {
            registry.invalidate_account_management_document(window_label);
        }
    }
    reload()
}

// The owning window is relevant only to readiness at reload time.
// Recovery budgets use the WebView label.
fn renderer_window_label(view: &tauri::Webview) -> String {
    view.window().label().to_owned()
}

#[cfg(not(target_os = "macos"))]
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
                    let state = app.try_state::<crate::AppState>();
                    let registry = state.as_ref().map(|state| &state.window_registry);
                    let window_label = renderer_window_label(&webview);
                    let result = reload_renderer(registry, webview.label(), &window_label, || webview.reload());
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

/// A fixed-schema diagnostic envelope; no terminal strings are accepted as log fields.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalDiagnostic {
    kind: String,
    event: String,
    session: String,
    #[serde(default)]
    numbers: std::collections::BTreeMap<String, u64>,
    requested: Option<String>,
    actual: Option<String>,
    reason: Option<String>,
    exception: Option<String>,
}

impl TerminalDiagnostic {
    fn line(&self, webview: &str) -> Option<String> {
        if !["renderer", "progress", "recovery"].contains(&self.kind.as_str())
            || !["context-loss", "budget-evict", "budget-denied", "dispose-result", "retry", "exhausted",
                "fallback-ready", "stall", "start", "end", "failed", "aborted", "coalesced"].contains(&self.event.as_str()) {
            return None;
        }
        let session = if self.session.len() == 8 && self.session.bytes().all(|b| b.is_ascii_hexdigit()) {
            self.session.as_str()
        } else { "unknown" };
        let view: String = webview.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(16).collect();
        if self.event == "coalesced" {
            let mut line = format!("[terminal-diagnostic] event=coalesced webview={view} session={session}");
            for (key, value) in &self.numbers {
                if matches!(key.as_str(), "coalesced" | "count_context_loss" | "count_budget_evict"
                    | "count_budget_protected" | "count_budget_dispose_failed"
                    | "count_dispose_result" | "count_dispose_failed" | "count_retry" | "count_exhausted"
                    | "count_fallback_ready" | "count_stall" | "count_start" | "count_end" | "count_failed"
                    | "count_aborted" | "count_window_evicted" | "count_tool_disclosure_evicted"
                    | "count_exception_error" | "count_exception_type_error"
                    | "count_exception_range_error" | "count_exception_unknown") || ["paint", "manual", "channel"].iter().any(|reason|
                        ["start", "end", "failed", "aborted", "stall"].iter().any(|event|
                            key == &format!("count_{reason}_{event}")))
                {
                    line.push_str(&format!(" {key}={value}"));
                }
            }
            return Some(line);
        }
        let renderer = |value: Option<&str>| match value {
            Some("auto") => "auto", Some("webgl") => "webgl", Some("dom") => "dom", _ => "unknown",
        };
        let reason = match self.reason.as_deref() {
            Some("paint") => "paint", Some("channel") => "channel",
            Some("manual") => "manual", _ => "unknown",
        };
        let exception = match self.exception.as_deref() {
            Some("error") => "error", Some("type-error") => "type-error",
            Some("range-error") => "range-error", Some("none") | None => "none", _ => "unknown",
        };
        let mut line = format!("[terminal-{}] event={} webview={view} session={session} requested={} actual={} reason={reason} exception={exception}",
            self.kind, self.event, renderer(self.requested.as_deref()), renderer(self.actual.as_deref()));
        for (key, value) in &self.numbers {
            if ["term", "visible", "focused", "budget", "victim", "requester", "attempt", "dom_ready",
                "dispose_ok", "budget_protected", "generation", "received_end", "parsed_end", "reused",
                "observed_at_ms", "coalesced"].contains(&key.as_str()) {
                line.push_str(&format!(" {key}={value}"));
            }
        }
        if self.kind == "progress" && self.event == "stall" {
            for key in ["generation", "received_end", "parsed_end"] {
                if !self.numbers.contains_key(key) {
                    line.push_str(&format!(" {key}=unknown"));
                }
            }
        }
        Some(line)
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
    #[serde(default)]
    pub heap_alert: bool,
    #[serde(default)]
    pub live_count: u32,
    #[serde(default)]
    pub cache_count: u32,
    #[serde(default)]
    pub pending_tickets: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    progress: Option<RendererProgress>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererProgress {
    timer_delay_ms: u64,
    longest_frame_ms: u64,
    work_kind: RendererWork,
    work_ms: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RendererWork {
    LongTask,
    StyleLayout,
    RenderCallbacks,
    EventListener,
    UserCallback,
    Promise,
    Script,
    #[serde(other)]
    Unknown,
}

impl RendererWork {
    fn label(self) -> &'static str {
        match self {
            Self::LongTask => "long-task",
            Self::StyleLayout => "style-layout",
            Self::RenderCallbacks => "render-callbacks",
            Self::EventListener => "event-listener",
            Self::UserCallback => "user-callback",
            Self::Promise => "promise",
            Self::Script => "script",
            Self::Unknown => "unknown",
        }
    }
}

const VISIBLE_RENDERER_GAP_MS: u64 = 45_000;
const RENDERER_STALL_SAMPLE_MS: u64 = 1000;
const RENDERER_HEARTBEAT_INTERVAL_MS: u64 = 30_000;

struct RendererWatch {
    last_seen_ms: u64,
    silent: bool,
    last_sample_ms: Option<u64>,
    last_long_sample_ms: Option<u64>,
    last_visible_progress: Option<RendererProgress>,
}

impl RendererWatch {
    fn new(now_ms: u64) -> Self {
        Self {
            last_seen_ms: now_ms,
            silent: false,
            last_sample_ms: None,
            last_long_sample_ms: None,
            last_visible_progress: None,
        }
    }

    fn poll(&mut self, now_ms: u64) -> Option<String> {
        let gap = now_ms.saturating_sub(self.last_seen_ms);
        let threshold = if self.last_visible_progress.is_some() { VISIBLE_RENDERER_GAP_MS } else { 120_000 };
        if self.silent || gap < threshold {
            return None;
        }
        self.silent = true;
        Some(match self.last_visible_progress {
            Some(progress) => format!(
                "[watchdog] renderer silent heartbeat_gap_ms={gap} last_work={} last_work_ms={} last_frame_ms={}",
                progress.work_kind.label(), progress.work_ms, progress.longest_frame_ms
            ),
            None => "[watchdog] renderer silent".to_string(),
        })
    }

    fn heartbeat(&mut self, heartbeat: &RendererHeartbeat, now_ms: u64) -> Vec<String> {
        let mut lines = Vec::new();
        if std::mem::take(&mut self.silent) {
            lines.push(format!(
                "[watchdog] renderer back after {}s",
                now_ms.saturating_sub(self.last_seen_ms) / 1000
            ));
        }
        let mut progress = heartbeat.progress;
        if let Some(progress) = progress.as_mut() {
            let awake_delay = self.last_sample_ms.map_or(0, |_| {
                now_ms.saturating_sub(self.last_seen_ms).saturating_sub(RENDERER_HEARTBEAT_INTERVAL_MS)
            });
            progress.timer_delay_ms = progress.timer_delay_ms.min(awake_delay);
        }
        self.last_seen_ms = now_ms;
        self.last_visible_progress = progress.filter(|_| heartbeat.visibility == "visible");
        if let Some(progress) = progress {
            if progress.timer_delay_ms >= RENDERER_STALL_SAMPLE_MS
                || progress.longest_frame_ms >= RENDERER_STALL_SAMPLE_MS
                || heartbeat.max_long_task_ms >= RENDERER_STALL_SAMPLE_MS as f64
            {
                lines.push(format!(
                    "[renderer-stall] timer_delay_ms={} max_longtask_ms={:.1} longest_frame_ms={} work={} work_ms={}",
                    progress.timer_delay_ms, heartbeat.max_long_task_ms, progress.longest_frame_ms,
                    progress.work_kind.label(), progress.work_ms
                ));
            }
        }
        let periodic = self
            .last_sample_ms
            .map_or(true, |at| now_ms.saturating_sub(at) >= 600_000);
        let long_task = heartbeat.max_long_task_ms >= 1000.0
            && self
                .last_long_sample_ms
                .map_or(true, |at| now_ms.saturating_sub(at) >= 30_000);
        if periodic || long_task || heartbeat.heap_alert {
            let heap = heartbeat
                .heap_used_mib
                .map_or_else(|| "unknown".to_string(), |mib| format!("{mib:.1}"));
            let visibility = match heartbeat.visibility.as_str() {
                "visible" | "hidden" | "prerender" => heartbeat.visibility.as_str(),
                _ => "unknown",
            };
            lines.push(format!(
                "[renderer] heap_used_mib={heap} longtasks={} max_longtask_ms={:.1} xterm={} pending_invokes={} visibility={visibility} focus={}",
                heartbeat.long_tasks, heartbeat.max_long_task_ms, heartbeat.xterm_count,
                heartbeat.pending_invokes, heartbeat.focus
            ));
            self.last_sample_ms = Some(now_ms);
            if long_task {
                self.last_long_sample_ms = Some(now_ms);
            }
        }
        lines
    }
}

/// A hidden tear-out spare has a live renderer of its own. Its heartbeat
/// must not conceal a hung main UI (or a hung, visible child window).
#[derive(Default)]
struct RendererWatches {
    views: HashMap<String, RendererWatch>,
}

impl RendererWatches {
    fn heartbeat(&mut self, label: &str, heartbeat: &RendererHeartbeat, now_ms: u64) -> Vec<String> {
        self.views.entry(label.to_string()).or_insert_with(|| RendererWatch::new(now_ms))
            .heartbeat(heartbeat, now_ms).into_iter()
            .map(|line| {
                let line = format!("{line} webview={label}");
                if !line.starts_with("[renderer] ") { return line; }
                format!("{line} |diag-meta| live={} cache={} pending_tickets={}",
                    heartbeat.live_count, heartbeat.cache_count, heartbeat.pending_tickets)
            }).collect()
    }

    fn poll(&mut self, now_ms: u64, exists: impl Fn(&str) -> bool) -> Vec<String> {
        self.views.retain(|label, _| exists(label));
        self.views.iter_mut().filter_map(|(label, watch)|
            watch.poll(now_ms).map(|line| format!("{line} webview={label}"))).collect()
    }
}

#[tauri::command]
pub async fn report_renderer_heartbeat(
    caller: tauri::Webview,
    heartbeat: Option<RendererHeartbeat>,
    diagnostic: Option<TerminalDiagnostic>,
) -> Result<(), String> {
    if heartbeat.is_none() && diagnostic.is_none() {
        return Err("missing renderer heartbeat or diagnostic".to_string());
    }
    let diagnostic_line = match diagnostic {
        Some(diagnostic) => Some(diagnostic.line(caller.label())
            .ok_or_else(|| "invalid terminal diagnostic".to_string())?),
        None => None,
    };
    if let Some(heartbeat) = heartbeat {
        if heartbeat.heap_used_mib.is_some_and(|value| !value.is_finite() || value < 0.0)
            || !heartbeat.max_long_task_ms.is_finite() || heartbeat.max_long_task_ms < 0.0 {
            return Err("invalid renderer heartbeat measurements".to_string());
        }
        let lines = renderers().lock().unwrap_or_else(|p| p.into_inner())
            .heartbeat(caller.label(), &heartbeat, renderer_clock_ms());
        for line in lines { log_with_memory(line); }
    }
    if let Some(line) = diagnostic_line { log_with_memory(line); }
    Ok(())
}

// Register this instead of terminal::kill_session solely to time the entire
// command, including the queued hook drain, ConPTY teardown and file cleanup.
// The command itself moves blocking work to the blocking pool.
#[tauri::command]
pub async fn measured_kill_session(
    app_handle: AppHandle,
    state: State<'_, crate::AppState>,
    session_id: String,
) -> Result<(), String> {
    static LIMITS: OnceLock<Mutex<(RateLimit, RateLimit)>> = OnceLock::new();
    let start = Instant::now();
    let result = crate::commands::terminal::kill_session(app_handle, state, session_id.clone()).await;
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
    renderers().lock().unwrap_or_else(|p| p.into_inner()).views
        .entry("main".to_string()).or_insert_with(|| RendererWatch::new(renderer_clock_ms()));
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
                lines.extend(renderers().lock().unwrap_or_else(|p| p.into_inner())
                    .poll(renderer_clock_ms(), |label| app.get_webview(label).is_some()));
                recover_renderers(&app, &mut recoveries, failure_receiver.try_iter(), now_ms, &mut lines);
                for (line, dropped) in receiver.try_iter() {
                    lines.push(line);
                    if dropped > 0 {
                        lines.push(format!("[diag-queue] dropped={dropped}"));
                    }
                }
                if !lines.is_empty() {
                    let ram =
                        free_ram_mib().map_or_else(|| "unknown".to_string(), |mib| mib.to_string());
                    for line in lines {
                        crate::diag::log(&format_with_memory(&line, &ram));
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

/// Reuse the watchdog's OS probe on the blocking pool, without a new sampler.
#[tauri::command(async)]
pub async fn get_available_memory_mib() -> Result<Option<u64>, String> {
    crate::util::task::run_blocking("get_available_memory_mib", || Ok(free_ram_mib())).await
}

#[cfg(not(windows))]
fn free_ram_mib() -> Option<u64> {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    (system.total_memory() > 0).then(|| system.available_memory() / (1024 * 1024))
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
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED.0 {
                    crate::commands::webpane_native::native_input_renderer_failed(&webview_label);
                }
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

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn register_process_failed(_webview: &tauri::Webview) {}

/// Mac recovery gives each webview its own retry budget, matching Windows.
/// The callback itself performs no reload, native getter, disk I/O or PTY work.
#[cfg(target_os = "macos")]
fn queue_renderer_failure(webview: String, kind: i32) {
    if let Some(queue) = FAILURES.get() {
        if queue.try_send(RendererFailure { webview, kind }).is_err() {
            log_with_memory("[webkit] recovery queue full; reload not scheduled".into());
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct MacReloadBudget {
    budget: ReloadBudget,
    pending: VecDeque<RendererFailure>,
}

#[cfg(target_os = "macos")]
impl MacReloadBudget {
    fn failed(&mut self, failure: RendererFailure) {
        if let Some(existing) = self.pending.iter_mut().find(|item| item.webview == failure.webview) {
            existing.kind = failure.kind;
        } else if failure.webview.starts_with("web-pane-") {
            self.pending.push_back(failure);
        } else {
            // A shared process can take down both the app and a web pane.
            // Restore the control UI first without multiplying the budget.
            self.pending.push_front(failure);
        }
    }

    fn poll(&mut self, now_ms: u64) -> Option<(String, RecoveryDecision)> {
        let failure = self.pending.front()?;
        self.budget.failed(failure.kind);
        let decision = match self.budget.poll(now_ms) {
            Some(decision) => decision,
            None => {
                // An exhausted budget consumes even later repeated failures.
                // Do not carry those across the ten-minute window as a retry.
                if self.budget.pending.is_none() { self.pending.clear(); }
                return None;
            }
        };
        let label = self.pending.pop_front()?.webview;
        if matches!(decision, RecoveryDecision::GiveUp { .. }) {
            self.pending.clear();
        }
        Some((label, decision))
    }
}

#[cfg(target_os = "macos")]
fn recover_renderers(
    app: &AppHandle,
    budgets: &mut HashMap<String, MacReloadBudget>,
    failures: impl Iterator<Item = RendererFailure>,
    now_ms: u64,
    lines: &mut Vec<String>,
) {
    for failure in failures {
        if app.get_webview(&failure.webview).is_some() {
            budgets.entry(failure.webview.clone()).or_default().failed(failure);
        }
    }
    budgets.retain(|label, _| app.get_webview(label).is_some());
    for recovery in budgets.values_mut() {
        recovery.pending.retain(|failure| app.get_webview(&failure.webview).is_some());
        match recovery.poll(now_ms) {
            Some((label, RecoveryDecision::Reload { attempt, kind })) => {
                if let Some(view) = app.get_webview(&label) {
                    // The dedicated watchdog worker dispatches this reload.
                    // Existing PTYs are reattached by ID, never recreated here.
                    let state = app.try_state::<crate::AppState>();
                    let registry = state.as_ref().map(|state| &state.window_registry);
                    let window_label = renderer_window_label(&view);
                    let result = reload_renderer(registry, view.label(), &window_label, || view.reload());
                    lines.push(format!(
                        "[webkit] renderer reload webview={label} kind={kind} attempt={attempt}/{MAX_RELOADS} success={} error={:?}",
                        result.is_ok(), result.err().map(|error| error.to_string())
                    ));
                }
            }
            Some((label, RecoveryDecision::GiveUp { kind })) => lines.push(format!(
                "[webkit] renderer recovery give up webview={label} kind={kind} limit={MAX_RELOADS}/10min"
            )),
            None => {}
        }
    }
}

/// Tauri does not expose wry's on_web_content_process_terminate builder hook.
/// Chain the existing delegate method instead of replacing its navigation,
/// permission or download delegate. Associated strings belong to the native
/// webview and are released by objc on deallocation; no pointer registry leaks.
#[cfg(target_os = "macos")]
mod mac_process_failed {
    use super::{log_with_memory, queue_renderer_failure};
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2_foundation::NSString;
    use std::ffi::c_void;
    use std::sync::OnceLock;

    type Terminated = unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject);
    static ORIGINAL: OnceLock<Terminated> = OnceLock::new();
    static LABEL_KEY: u8 = 0;

    // These public objc runtime functions require no new dependency/feature.
    extern "C" {
        fn objc_setAssociatedObject(object: *const AnyObject, key: *const c_void,
            value: *const AnyObject, policy: usize);
        fn objc_getAssociatedObject(object: *const AnyObject, key: *const c_void) -> *const AnyObject;
    }

    unsafe extern "C-unwind" fn terminated(delegate: &AnyObject, selector: Sel, view: &AnyObject) {
        // Preserve wry's original callback, including a future handler it sets.
        if let Some(original) = ORIGINAL.get() {
            unsafe { original(delegate, selector, view) };
        }
        let value = unsafe { objc_getAssociatedObject(view, (&LABEL_KEY as *const u8).cast()) };
        if value.is_null() { return; }
        // Only this module stores NSString under this private association key.
        let text = unsafe { &*(value as *const NSString) }.to_string();
        let Some((window, label)) = text.split_once('\n') else { return; };
        log_with_memory(format!(
            "[webkit] ProcessFailed kind=Some(1) exit_code=None window={window} webview={label} event=webViewWebContentProcessDidTerminate"
        ));
        crate::commands::webpane_native::native_input_renderer_failed(label);
        queue_renderer_failure(label.to_string(), 1);
    }

    pub(super) unsafe fn register(view: &AnyObject, window: &str, label: &str) -> Result<(), String> {
        let delegate: Option<&AnyObject> = unsafe { objc2::msg_send![view, navigationDelegate] };
        let delegate = delegate.ok_or_else(|| "WKWebView has no navigation delegate".to_string())?;
        let class: &AnyClass = delegate.class();
        // wry names its ObjC classes with module_path and the crate version.
        // This exact registered name matches the pinned Cargo.lock dependency.
        if class.name().to_bytes() != b"wry::wkwebview::class::wry_navigation_delegate::WryNavigationDelegate0.54.4" {
            return Err(format!("unexpected navigation delegate {}", class.name().to_string_lossy()));
        }
        let method = class.instance_method(objc2::sel!(webViewWebContentProcessDidTerminate:))
            .ok_or_else(|| "wry termination callback is missing".to_string())?;
        if method.arguments_count() != 3 {
            return Err("unexpected wry termination callback signature".into());
        }
        if ORIGINAL.get().is_none() {
            // All registrations and WebKit callbacks execute on the main
            // thread. Publish the original before installing our callback.
            let original: Terminated = unsafe { std::mem::transmute(method.implementation()) };
            let _ = ORIGINAL.set(original);
            let hook: Imp = unsafe { std::mem::transmute(terminated as Terminated) };
            unsafe { method.set_implementation(hook) };
        }
        let value = NSString::from_str(&format!("{window}\n{label}"));
        // OBJC_ASSOCIATION_RETAIN_NONATOMIC = 1. Main-thread-only access, and
        // objc owns the retained string until this exact WKWebView is freed.
        unsafe { objc_setAssociatedObject(view, (&LABEL_KEY as *const u8).cast(),
            &*value as *const NSString as *const AnyObject, 1) };
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn register_process_failed(webview: &tauri::Webview) {
    let window = webview.window().label().to_string();
    let label = webview.label().to_string();
    let posted = label.clone();
    if let Err(error) = crate::mac_webview::with_webview(webview, move |platform| {
        let view = unsafe { &*(platform.inner() as *const objc2::runtime::AnyObject) };
        if let Err(error) = unsafe { mac_process_failed::register(view, &window, &posted) } {
            log_with_memory(format!("[webkit] ProcessFailed registration failed window={window} webview={posted}: {error}"));
        }
    }) {
        log_with_memory(format!("[webkit] ProcessFailed registration post failed webview={label}: {error}"));
    }
}

#[cfg(target_os = "macos")]
pub(crate) use register_process_failed as register_mac_process_failed;

#[cfg(all(test, target_os = "macos"))]
mod mac_tests {
    use super::*;

    fn failure(label: &str) -> RendererFailure {
        RendererFailure { webview: label.into(), kind: 1 }
    }

    #[test]
    fn web_pane_failures_never_use_the_main_ui_budget_or_cooldown() {
        let mut budgets = HashMap::<String, MacReloadBudget>::new();
        for at in [0, 60_000, 120_000] {
            let web = budgets.entry("web-pane-a".into()).or_default();
            web.failed(failure("web-pane-a"));
            assert!(matches!(web.poll(at), Some((_, RecoveryDecision::Reload { .. }))));
        }
        let main = budgets.entry("main".into()).or_default();
        main.failed(failure("main"));
        assert_eq!(main.poll(120_001), Some(("main".into(), RecoveryDecision::Reload { attempt: 1, kind: 1 })));
        main.failed(failure("main"));
        assert!(main.poll(120_002).is_none());
        let other = budgets.entry("web-pane-b".into()).or_default();
        other.failed(failure("web-pane-b"));
        assert_eq!(other.poll(120_002), Some(("web-pane-b".into(), RecoveryDecision::Reload { attempt: 1, kind: 1 })));
    }

    #[test]
    fn reparenting_keeps_the_webview_failure_and_budget() {
        let mut budgets = HashMap::<String, MacReloadBudget>::new();
        let label = "web-pane-moving";
        budgets.entry(label.into()).or_default().failed(failure(label));
        // A window change does not change the identity used by the worker.
        assert_eq!(budgets.get_mut(label).unwrap().poll(0), Some((label.into(), RecoveryDecision::Reload { attempt: 1, kind: 1 })));
        budgets.get_mut(label).unwrap().failed(failure(label));
        assert_eq!(budgets.get_mut(label).unwrap().poll(60_000), Some((label.into(), RecoveryDecision::Reload { attempt: 2, kind: 1 })));
    }

    #[test]
    fn duplicate_callbacks_coalesce_and_closed_views_do_not_use_a_retry() {
        let mut window = MacReloadBudget::default();
        for _ in 0..1000 { window.failed(failure("main")); }
        window.failed(failure("web-pane-closed"));
        assert_eq!(window.pending.len(), 2);
        window.pending.retain(|event| event.webview != "web-pane-closed");
        assert!(matches!(window.poll(0), Some((_, RecoveryDecision::Reload { attempt: 1, .. }))));
        assert!(window.poll(60_000).is_none());
        assert_eq!(window.budget.attempts.len(), 1);
    }

    #[test]
    fn windows_recover_independently_and_give_up_does_not_retry_by_itself() {
        let mut first = MacReloadBudget::default();
        let mut second = MacReloadBudget::default();
        for at in [0, 60_000, 120_000] {
            first.failed(failure("main"));
            assert!(first.poll(at).is_some());
        }
        first.failed(failure("main"));
        assert!(matches!(first.poll(120_001), Some((_, RecoveryDecision::GiveUp { .. }))));
        second.failed(failure("child"));
        assert!(matches!(second.poll(120_001), Some((_, RecoveryDecision::Reload { attempt: 1, .. }))));
        first.failed(failure("main"));
        assert!(first.poll(180_000).is_none());
        assert!(first.pending.is_empty());
        assert!(first.poll(600_000).is_none());
        first.failed(failure("main"));
        assert!(matches!(first.poll(600_000), Some((_, RecoveryDecision::Reload { attempt: 3, .. }))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_management_is_unavailable_during_watchdog_reload_until_the_child_resubscribes() {
        let registry = crate::window_registry::WindowRegistry::new();
        let label = "mycmux-w1";
        let publisher = registry.register_fragment_publisher(label);
        let document = registry.account_management_document(label, Some(&publisher)).unwrap();
        assert!(registry.set_account_management_ready(label, Some(&publisher), document, 4, Some("old-listen".into())));
        let fragment = crate::window_registry::WindowFragment {
            window_label: label.into(),
            workspaces: vec![serde_json::json!({"id": "owned-workspace", "panes": []})],
            ..Default::default()
        };
        assert!(registry.publish_live_fragment(fragment, Some(&publisher)));
        assert!(registry.tab_index("mycmux-w2")[0].account_management_ready);

        reload_renderer(Some(&registry), "web-pane-embedded", label, || {
            assert!(registry.tab_index("mycmux-w2")[0].account_management_ready);
        });
        let mut budget = ReloadBudget::default();
        budget.failed(1);
        assert!(matches!(budget.poll(0), Some(RecoveryDecision::Reload { .. })));
        reload_renderer(Some(&registry), label, label, || {
            // The driver may hold the replacement document before it listens.
            let index = registry.tab_index("mycmux-w2");
            assert!(!index[0].account_management_ready);
            assert!(index[0].account_management_subscription.is_none());
            assert_eq!(index[0].workspaces[0].id, "owned-workspace");
        });

        assert!(!registry.set_account_management_ready(label, Some(&publisher), document, 5, Some("old-listen".into())));
        assert!(!registry.tab_index("mycmux-w2")[0].account_management_ready);
        let replacement = registry.account_management_document(label, Some(&publisher)).unwrap();
        assert_ne!(document, replacement);
        assert!(registry.set_account_management_ready(label, Some(&publisher), replacement, 1, Some("new-listen".into())));
        let index = registry.tab_index("mycmux-w2");
        assert!(index[0].account_management_ready);
        let subscription = index[0].account_management_subscription.as_ref().unwrap();
        assert_eq!(subscription.publication_id, publisher);
        assert_eq!(subscription.subscription_id, "new-listen");
    }

    #[test]
    fn int_fix5_watchdog_reload_withdraws_subscription_before_native_reload() {
        let registry = crate::window_registry::WindowRegistry::new();
        let label = "main";
        let publisher = registry.register_fragment_publisher(label);
        let document = registry.account_management_document(label, Some(&publisher)).unwrap();
        assert!(registry.set_account_management_ready(label, Some(&publisher), document, 1, Some("old-listener".into())));
        let fragment = crate::window_registry::WindowFragment {
            window_label: label.into(),
            workspaces: vec![serde_json::json!({"id": "watchdog-workspace", "panes": []})],
            ..Default::default()
        };
        assert!(registry.publish_live_fragment(fragment, Some(&publisher)));
        let index = || registry.tab_index("mycmux-w2").into_iter().find(|entry| entry.window_label == label).unwrap();
        assert!(index().account_management_ready);
        assert!(index().account_management_subscription.is_some());

        let mut reloads = 0;
        let result = reload_renderer(Some(&registry), label, label, || {
            let at_reload = index();
            assert!(!at_reload.account_management_ready);
            assert!(at_reload.account_management_subscription.is_none());
            assert_eq!(at_reload.workspaces[0].id, "watchdog-workspace");
            reloads += 1;
            Ok::<(), &str>(())
        });
        assert_eq!(result, Ok(()));
        assert_eq!(reloads, 1);
    }

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

    #[test]
    fn terminal_diagnostic_coalesces_only_named_events() {
        let sample: TerminalDiagnostic = serde_json::from_value(serde_json::json!({
            "kind": "renderer", "event": "coalesced", "session": "abcdef12",
            "numbers": {
                "coalesced": 3, "count_context_loss": 2, "count_manual_failed": 1, "count_private": 5,
                "count_exception_error": 1, "count_exception_type_error": 2,
                "count_exception_range_error": 3, "count_exception_unknown": 4,
                "count_exception_unapproved": 5
            }
        })).unwrap();
        let line = sample.line("main").unwrap();
        assert!(line.starts_with("[terminal-diagnostic] event=coalesced webview=main session=abcdef12"));
        for counter in ["coalesced=3", "count_context_loss=2", "count_manual_failed=1",
            "count_exception_error=1", "count_exception_type_error=2", "count_exception_range_error=3",
            "count_exception_unknown=4"] {
            assert!(line.split_whitespace().any(|field| field == counter), "{counter}");
        }
        assert!(!line.contains("private"));
        assert!(!line.contains("unapproved"));
    }

    fn heartbeat() -> RendererHeartbeat {
        RendererHeartbeat {
            heap_used_mib: Some(64.0),
            long_tasks: 0,
            max_long_task_ms: 0.0,
            xterm_count: 3,
            pending_invokes: 0,
            heap_alert: false, live_count: 2, cache_count: 1, pending_tickets: 0,
            visibility: "visible".to_string(),
            focus: true,
            progress: None,
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
    fn shared_legacy_heartbeat_masks_silence_but_per_view_watches_do_not() {
        let mut legacy = RendererWatch::new(0);
        let mut watches = RendererWatches::default();
        watches.heartbeat("main", &heartbeat(), 0);
        for now in (30_000..=120_000).step_by(30_000) {
            legacy.heartbeat(&heartbeat(), now);
            watches.heartbeat("mycmux-w1", &heartbeat(), now);
            assert!(legacy.poll(now).is_none());
        }
        assert!(watches.poll(119_999, |_| true).is_empty());
        assert_eq!(watches.poll(120_000, |_| true), vec!["[watchdog] renderer silent webview=main"]);
    }

    #[test]
    fn per_view_renderer_metrics_keep_the_existing_prefix_and_rate_limits() {
        let mut watches = RendererWatches::default();
        for label in ["main", "mycmux-w1"] {
            let lines = watches.heartbeat(label, &heartbeat(), 0);
            assert_eq!(lines.len(), 1);
            assert!(lines[0].starts_with("[renderer] heap_used_mib=64.0 "));
            let formatted = format_with_memory(&lines[0], "4096");
            assert!(formatted.starts_with(&format!("[renderer] heap_used_mib=64.0 longtasks=0 max_longtask_ms=0.0 xterm=3 pending_invokes=0 visibility=visible focus=true webview={label} free_ram_mib=4096 ")));
            assert!(formatted.ends_with("live=2 cache=1 pending_tickets=0"));
            assert!(watches.heartbeat(label, &heartbeat(), 30_000).is_empty());
            assert_eq!(watches.heartbeat(label, &heartbeat(), 600_000).len(), 1);
        }
    }

    #[test]
    fn a_spare_heartbeat_cannot_conceal_a_silent_main_renderer() {
        let mut watches = RendererWatches::default();
        watches.heartbeat("main", &heartbeat(), 0);
        for now in (30_000..=120_000).step_by(30_000) {
            watches.heartbeat("mycmux-w1", &heartbeat(), now);
        }
        assert_eq!(watches.poll(120_000, |_| true), vec!["[watchdog] renderer silent webview=main"]);
        assert!(watches.poll(130_000, |_| true).is_empty());
        let back = watches.heartbeat("main", &heartbeat(), 135_000);
        assert_eq!(back[0], "[watchdog] renderer back after 135s webview=main");
        assert!(watches.heartbeat("mycmux-w1", &heartbeat(), 135_000).is_empty());
    }
    #[test]
    fn a_live_main_heartbeat_cannot_conceal_a_silent_child_renderer() {
        let mut watches = RendererWatches::default();
        watches.heartbeat("mycmux-w2", &heartbeat(), 0);
        watches.heartbeat("main", &heartbeat(), 120_000);
        assert_eq!(watches.poll(120_000, |_| true), vec!["[watchdog] renderer silent webview=mycmux-w2"]);
    }
    #[test]
    fn destroyed_renderers_are_pruned_without_false_silence() {
        let mut watches = RendererWatches::default();
        watches.heartbeat("closed", &heartbeat(), 0);
        assert!(watches.poll(120_000, |_| false).is_empty());
        assert!(watches.views.is_empty());
    }
    #[test]
    fn visible_renderer_logs_an_early_gap_and_measured_work_on_return() {
        let mut watches = RendererWatches::default();
        let mut sample = heartbeat();
        sample.progress = Some(RendererProgress {
            timer_delay_ms: 0, longest_frame_ms: 250, work_kind: RendererWork::UserCallback, work_ms: 150,
        });
        watches.heartbeat("main", &sample, 1000);
        assert!(watches.poll(45_999, |_| true).is_empty());
        let gap = watches.poll(46_000, |_| true);
        assert_eq!(gap, vec!["[watchdog] renderer silent heartbeat_gap_ms=45000 last_work=user-callback last_work_ms=150 last_frame_ms=250 webview=main"]);
        assert!(watches.poll(60_000, |_| true).is_empty());

        sample.progress = Some(RendererProgress {
            timer_delay_ms: 50_429, longest_frame_ms: 50_000, work_kind: RendererWork::StyleLayout, work_ms: 42_000,
        });
        let lines = watches.heartbeat("main", &sample, 81_429);
        let stall = lines.iter().find(|line| line.starts_with("[renderer-stall]")).unwrap();
        assert_eq!(format_with_memory(stall, "3726"),
            "[renderer-stall] timer_delay_ms=50429 max_longtask_ms=0.0 longest_frame_ms=50000 work=style-layout work_ms=42000 webview=main free_ram_mib=3726");
    }

    #[test]
    fn l3_105_reported_timer_gap_is_bounded_by_host_awake_elapsed_time() {
        let mut watch = RendererWatch::new(0);
        let mut sample = heartbeat();
        sample.visibility = "visible".into();
        assert!(!watch.heartbeat(&sample, 0).is_empty());
        sample.progress = Some(RendererProgress {
            timer_delay_ms: 120_000, longest_frame_ms: 0,
            work_kind: RendererWork::Unknown, work_ms: 0,
        });
        assert!(!watch.heartbeat(&sample, 30_000).iter().any(|line| line.starts_with("[renderer-stall]")));
        assert!(watch.heartbeat(&sample, 180_000).iter().any(|line| line.starts_with("[renderer-stall]")));
    }

    #[test]
    fn l3_fix2_22_initial_renderer_sample_does_not_count_unobserved_sleep_as_a_stall() {
        let mut watches = RendererWatches::default();
        let mut sample = heartbeat();
        sample.visibility = "visible".into();
        sample.progress = Some(RendererProgress {
            timer_delay_ms: 120_000, longest_frame_ms: 0,
            work_kind: RendererWork::Unknown, work_ms: 0,
        });
        assert!(!watches.heartbeat("main", &sample, 30_000).iter()
            .any(|line| line.starts_with("[renderer-stall]")));
        assert!(watches.heartbeat("main", &sample, 180_000).iter()
            .any(|line| line.starts_with("[renderer-stall]")));
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
            "maxLongTaskMs": 0.0, "xtermCount": 3, "heapAlert": false,
            "liveCount": 2, "cacheCount": 1, "pendingTickets": 0, "pendingInvokes": 0,
            "visibility": "visible", "focus": true })
        );
        let parsed: RendererHeartbeat = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.xterm_count, 3);
        let legacy: RendererHeartbeat = serde_json::from_value(serde_json::json!({
            "heapUsedMib": 64.0, "longTasks": 0, "maxLongTaskMs": 0.0, "xtermCount": 3,
            "pendingInvokes": 7, "visibility": "visible", "focus": true
        })).unwrap();
        assert_eq!(legacy.pending_invokes, 7);
        assert_eq!(legacy.pending_tickets, 0);
    }

    #[test]
    fn terminal_diagnostic_queue_reports_dropped_count_on_the_next_writable_enqueue() {
        let (queue, receiver) = mpsc::sync_channel(2);
        let dropped = AtomicU64::new(0);
        enqueue_log_with_drop_count(&queue, &dropped, "first".into());
        enqueue_log_with_drop_count(&queue, &dropped, "second".into());
        enqueue_log_with_drop_count(&queue, &dropped, "private discarded content".into());
        enqueue_log_with_drop_count(&queue, &dropped, "another discarded line".into());
        assert_eq!(dropped.load(Ordering::Relaxed), 2);
        assert_eq!(receiver.try_recv().unwrap(), ("first".to_string(), 0));
        enqueue_log_with_drop_count(&queue, &dropped, "resumed".into());
        assert_eq!(receiver.try_recv().unwrap(), ("second".to_string(), 0));
        assert_eq!(receiver.try_recv().unwrap(), ("resumed".to_string(), 2));
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn terminal_diagnostic_never_serializes_terminal_text_or_exception_values() {
        let sample: TerminalDiagnostic = serde_json::from_value(serde_json::json!({
            "kind": "renderer", "event": "context-loss", "session": "secret/title/path",
            "numbers": {"attempt": 2, "secret_body": 99}, "requested": "secret OSC",
            "actual": "webgl", "exception": "secret/key", "reason": "secret/path"
        })).unwrap();
        let line = sample.line("main").unwrap();
        assert!(line.contains("session=unknown"));
        assert!(line.contains("attempt=2"));
        assert!(!line.contains("secret"));
        assert!(!line.contains("OSC"));
    }

    #[test]
    fn terminal_diagnostic_marks_unmatched_frontend_offsets_unknown_and_omits_backend_fields() {
        let sample: TerminalDiagnostic = serde_json::from_value(serde_json::json!({
            "kind": "progress", "event": "stall", "session": "abcdef12", "actual": "webgl",
            "numbers": {"generation": 3, "received_end": 15, "observed_at_ms": 1000,
                        "backend_observed_at_ms": 2000, "backend_end": 99, "bytes": 5}
        })).unwrap();
        let line = sample.line("main").unwrap();
        assert!(line.contains("generation=3"));
        assert!(line.contains("received_end=15"));
        assert!(line.contains("parsed_end=unknown"));
        assert!(!line.contains("backend_"));
        assert!(!line.contains("bytes="));
    }

    #[test]
    fn drop_metadata_preserves_the_existing_scanner_prefixes() {
        let enter = format_with_memory("[pty] session=abcdef12 frontend drop enter |diag-meta| reason=stale_ack", "4096");
        assert!(enter.contains("frontend drop enter free_ram_mib=4096 reason=stale_ack"));
        let exit = format_with_memory("[pty] session=abcdef12 frontend drop exit after_ms=1000 |diag-meta| outcome=closed", "4096");
        assert!(exit.contains("frontend drop exit after_ms=1000 free_ram_mib=4096 outcome=closed"));
    }

    #[test]
    fn heap_alert_is_logged_before_the_periodic_deadline() {
        let mut watches = RendererWatches::default();
        let mut sample = heartbeat();
        watches.heartbeat("main", &sample, 0);
        sample.heap_alert = true;
        assert!(watches.heartbeat("main", &sample, 30_000)[0].contains("pending_tickets=0"));
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
