use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

use crate::events;

use super::monitor::{MetadataStore, PtyMetadata};
use super::osc7::Osc7Parser;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Notify};

const SCROLLBACK_CAP: usize = 256 * 1024; // 256 KB
const FRONTEND_QUEUE_CAP: usize = 256;
const FRONTEND_FLUSH_INTERVAL_MS: u64 = 16;
const FRONTEND_SATURATED_FLUSH_INTERVAL_MS: u64 = 4;
const FRONTEND_BATCH_MAX_BYTES: usize = 64 * 1024;
const FRONTEND_MAX_INFLIGHT_BYTES: usize = 512 * 1024;
const FRONTEND_LOW_WATER_BYTES: usize = 256 * 1024;
const FRONTEND_MAX_INFLIGHT_BATCHES: usize = 16;
// Two missed 2500 ms ACK windows enter AutoConsume well before the frontend
// writeTerminalOutput watchdog (30000 ms in XTermWrapper.tsx) resolves a stuck
// write. A later matching-generation ACK resets stale state and resumes sends.
const FRONTEND_ACK_TIMEOUT: Duration = Duration::from_millis(2500);
const FRONTEND_STALE_TIMEOUTS: u32 = 2;
const INPUT_QUEUE_MESSAGE_CAP: usize = 256;
const INPUT_QUEUE_BYTE_CAP: usize = 512 * 1024;
const INPUT_WRITE_CHUNK_BYTES: usize = 1024;
const FRONTEND_DATA_FRAME_HEADER_BYTES: usize = 40;
const SCROLLBACK_FRAME_HEADER_BYTES: usize = 24;
// v0.7.1 diag: report aggregated PTY metrics every 5 s on stderr.
// Diagnostic-only; the consumer task is debug-build-gated, so this is unread in
// release. Allow it explicitly to keep release warning-free.
#[allow(dead_code)]
const METRICS_FLUSH_INTERVAL_MS: u64 = 5_000;

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

static LAST_SESSION_EPOCH: AtomicU64 = AtomicU64::new(0);

fn next_session_epoch() -> u64 {
    loop {
        let previous = LAST_SESSION_EPOCH.load(Ordering::Relaxed);
        let next = epoch_millis().max(previous.saturating_add(1));
        if LAST_SESSION_EPOCH
            .compare_exchange_weak(previous, next, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return next;
        }
    }
}

fn record_last_output_at(last_output_at: &AtomicU64, at: u64) {
    last_output_at.store(at, Ordering::Relaxed);
}

fn read_last_output_at(last_output_at: &AtomicU64) -> Option<u64> {
    match last_output_at.load(Ordering::Relaxed) {
        0 => None,
        at => Some(at),
    }
}

// v0.7.1 diag: per-session counters shared by reader/forwarder threads.
// Used only for stderr reports; no behavior change. The reader task is
// debug-gated, so some counters are write-only in release — allow dead_code.
#[derive(Default)]
#[allow(dead_code)]
pub(crate) struct PtyMetrics {
    pub reads: std::sync::atomic::AtomicU64,
    pub read_micros_total: std::sync::atomic::AtomicU64,
    pub flushes: std::sync::atomic::AtomicU64,
    pub flushed_bytes: std::sync::atomic::AtomicU64,
    pub channel_send_errors: std::sync::atomic::AtomicU64,
    pub frontend_queue_full_retry: std::sync::atomic::AtomicU64,
    pub dropped_chunks: std::sync::atomic::AtomicU64,
    pub dropped_bytes: std::sync::atomic::AtomicU64,
    pub autoconsume_events: std::sync::atomic::AtomicU64,
    pub closed_count: std::sync::atomic::AtomicU64,
}

struct FrontendDataBatch {
    generation: u64,
    seq: u64,
    resync: bool,
    scrollback_start: u64,
    scrollback_end: u64,
    data: Vec<u8>,
}

impl FrontendDataBatch {
    fn into_wire(self) -> Vec<u8> {
        let mut frame = Vec::with_capacity(FRONTEND_DATA_FRAME_HEADER_BYTES + self.data.len());
        frame.extend_from_slice(b"MCX1");
        frame.extend_from_slice(&(u32::from(self.resync)).to_le_bytes());
        frame.extend_from_slice(&self.generation.to_le_bytes());
        frame.extend_from_slice(&self.seq.to_le_bytes());
        frame.extend_from_slice(&self.scrollback_start.to_le_bytes());
        frame.extend_from_slice(&self.scrollback_end.to_le_bytes());
        frame.extend_from_slice(&self.data);
        frame
    }
}

struct FrontendChunk {
    data: Vec<u8>,
    scrollback_start: u64,
    scrollback_end: u64,
}

pub struct ScrollbackSnapshot {
    pub data: Vec<u8>,
    pub start_offset: u64,
    pub end_offset: u64,
}

impl ScrollbackSnapshot {
    pub(crate) fn into_wire(self) -> Vec<u8> {
        let mut frame = Vec::with_capacity(SCROLLBACK_FRAME_HEADER_BYTES + self.data.len());
        frame.extend_from_slice(b"MCS1");
        frame.extend_from_slice(&0u32.to_le_bytes());
        frame.extend_from_slice(&self.start_offset.to_le_bytes());
        frame.extend_from_slice(&self.end_offset.to_le_bytes());
        frame.extend_from_slice(&self.data);
        frame
    }
}

struct QueuedInput {
    data: Vec<u8>,
    pending_bytes: Arc<AtomicUsize>,
}

impl Drop for QueuedInput {
    fn drop(&mut self) {
        self.pending_bytes
            .fetch_sub(self.data.len(), Ordering::Release);
    }
}

struct InFlight {
    generation: u64,
    seq: u64,
    bytes: usize,
    sent_at: Instant,
}

struct FrontendFlowState {
    data_channel: Channel<InvokeResponseBody>,
    generation: u64,
    next_seq: u64,
    inflight_bytes: usize,
    inflight: VecDeque<InFlight>,
    attached: bool,
    visible: bool,
    stale_timeouts: u32,
    dropped_since_send: bool,
    closing: bool,
}

struct FrontendFlow {
    inner: Mutex<FrontendFlowState>,
    notify: Notify,
}

enum FlowPermit {
    Send {
        generation: u64,
        seq: u64,
        resync: bool,
    },
    AutoConsume,
    Closed,
}

enum FlowSendError {
    Replaced,
    Closed,
    Disconnected,
}

impl FrontendFlow {
    fn new(data_channel: Channel<InvokeResponseBody>) -> Self {
        Self {
            inner: Mutex::new(FrontendFlowState {
                data_channel,
                generation: 1,
                next_seq: 1,
                inflight_bytes: 0,
                inflight: VecDeque::with_capacity(FRONTEND_MAX_INFLIGHT_BATCHES),
                attached: true,
                visible: true,
                stale_timeouts: 0,
                dropped_since_send: false,
                closing: false,
            }),
            notify: Notify::new(),
        }
    }

    async fn reserve(&self, bytes: usize) -> FlowPermit {
        loop {
            let sleep = tokio::time::sleep(FRONTEND_ACK_TIMEOUT);
            tokio::pin!(sleep);
            {
                let Ok(mut st) = self.inner.lock() else {
                    return FlowPermit::Closed;
                };
                if st.closing {
                    return FlowPermit::Closed;
                }
                if !st.attached || !st.visible || st.stale_timeouts >= FRONTEND_STALE_TIMEOUTS {
                    st.dropped_since_send = true;
                    return FlowPermit::AutoConsume;
                }
                Self::forgive_expired_locked(&mut st);
                if st.stale_timeouts >= FRONTEND_STALE_TIMEOUTS {
                    st.dropped_since_send = true;
                    return FlowPermit::AutoConsume;
                }
                let under_bytes =
                    st.inflight_bytes.saturating_add(bytes) <= FRONTEND_MAX_INFLIGHT_BYTES;
                let under_batches = st.inflight.len() < FRONTEND_MAX_INFLIGHT_BATCHES;
                if under_bytes && under_batches {
                    let seq = st.next_seq;
                    st.next_seq = st.next_seq.saturating_add(1);
                    let generation = st.generation;
                    let resync = st.dropped_since_send;
                    st.dropped_since_send = false;
                    st.inflight_bytes = st.inflight_bytes.saturating_add(bytes);
                    st.inflight.push_back(InFlight {
                        generation,
                        seq,
                        bytes,
                        sent_at: Instant::now(),
                    });
                    return FlowPermit::Send {
                        generation,
                        seq,
                        resync,
                    };
                }
            }

            tokio::select! {
                _ = self.notify.notified() => {}
                _ = &mut sleep => {
                    if let Ok(mut st) = self.inner.lock() {
                        Self::forgive_expired_locked(&mut st);
                    }
                    self.notify.notify_waiters();
                }
            }
        }
    }

    fn send_batch(&self, batch: FrontendDataBatch) -> Result<(), FlowSendError> {
        let data_channel = {
            let st = self.inner.lock().map_err(|_| FlowSendError::Closed)?;
            if st.closing {
                return Err(FlowSendError::Closed);
            }
            if batch.generation != st.generation {
                return Err(FlowSendError::Replaced);
            }
            st.data_channel.clone()
        };
        data_channel
            .send(InvokeResponseBody::Raw(batch.into_wire()))
            .map_err(|_| FlowSendError::Disconnected)
    }

    fn mark_dropped(&self) {
        let Ok(mut st) = self.inner.lock() else {
            return;
        };
        if !st.closing {
            st.dropped_since_send = true;
            self.notify.notify_waiters();
        }
    }

    fn forgive_expired_locked(st: &mut FrontendFlowState) {
        let now = Instant::now();
        let mut expired = false;
        while let Some(front) = st.inflight.front() {
            if now.duration_since(front.sent_at) < FRONTEND_ACK_TIMEOUT {
                break;
            }
            let item = st.inflight.pop_front().unwrap();
            st.inflight_bytes = st.inflight_bytes.saturating_sub(item.bytes);
            expired = true;
        }
        if expired {
            st.stale_timeouts = st.stale_timeouts.saturating_add(1);
        }
    }

    fn ack(&self, generation: u64, seq: u64, _bytes: usize) {
        let Ok(mut st) = self.inner.lock() else {
            return;
        };
        if generation != st.generation || st.closing {
            return;
        }
        st.stale_timeouts = 0;
        let mut acked = false;
        while let Some(front) = st.inflight.front() {
            if front.generation != generation || front.seq > seq {
                break;
            }
            let item = st.inflight.pop_front().unwrap();
            st.inflight_bytes = st.inflight_bytes.saturating_sub(item.bytes);
            acked = true;
        }
        if acked || st.inflight_bytes <= FRONTEND_LOW_WATER_BYTES {
            self.notify.notify_waiters();
        }
    }

    fn cancel(&self, generation: u64, seq: u64) {
        let Ok(mut st) = self.inner.lock() else {
            return;
        };
        if generation != st.generation || st.closing {
            return;
        }
        if let Some(index) = st
            .inflight
            .iter()
            .position(|item| item.generation == generation && item.seq == seq)
        {
            if let Some(item) = st.inflight.remove(index) {
                st.inflight_bytes = st.inflight_bytes.saturating_sub(item.bytes);
            }
        }
        st.stale_timeouts = FRONTEND_STALE_TIMEOUTS;
        st.attached = false;
        self.notify.notify_waiters();
    }

    fn replace_channel(
        &self,
        data_channel: Channel<InvokeResponseBody>,
    ) -> Result<(String, String), String> {
        let mut st = self.inner.lock().map_err(|e| format!("Lock failed: {e}"))?;
        let old_channel_id = st.data_channel.id().to_string();
        let new_channel_id = data_channel.id().to_string();
        st.data_channel = data_channel;
        st.generation = st.generation.saturating_add(1);
        st.next_seq = 1;
        st.inflight.clear();
        st.inflight_bytes = 0;
        st.attached = true;
        st.visible = true;
        st.stale_timeouts = 0;
        st.dropped_since_send = false;
        self.notify.notify_waiters();
        Ok((old_channel_id, new_channel_id))
    }

    fn set_visible(&self, visible: bool) {
        let Ok(mut st) = self.inner.lock() else {
            return;
        };
        st.visible = visible;
        if visible {
            st.stale_timeouts = 0;
        }
        if !visible {
            st.inflight.clear();
            st.inflight_bytes = 0;
        }
        self.notify.notify_waiters();
    }

    fn close(&self) {
        let Ok(mut st) = self.inner.lock() else {
            return;
        };
        st.closing = true;
        self.notify.notify_waiters();
    }
}

pub struct PtySession {
    child: Mutex<Box<dyn Child + Send + Sync>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    // Input is enqueued here and drained in FIFO order by a dedicated writer
    // thread. The Tauri command thread only does a non-blocking enqueue, so a
    // full conpty buffer can never stall the UI thread anymore.
    write_tx: mpsc::Sender<QueuedInput>,
    write_pending_bytes: Arc<AtomicUsize>,
    writer_failed: Arc<AtomicBool>,
    pub broadcast: broadcast::Sender<Vec<u8>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
    scrollback_end: Arc<AtomicU64>,
    last_output_at: Arc<AtomicU64>,
    session_epoch: u64,
    frontend_flow: Arc<FrontendFlow>,
    pub created_at: Instant,
    #[allow(dead_code)]
    pub(crate) metrics: Arc<PtyMetrics>,
}

// Safety: child/master/scrollback/data_channel are behind Mutex and write_tx is
// itself Send + Sync, so concurrent &PtySession access is serialized.
unsafe impl Sync for PtySession {}

impl PtySession {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        session_id: String,
        command: &str,
        args: &[String],
        cols: u16,
        rows: u16,
        data_channel: Channel<InvokeResponseBody>,
        app_handle: AppHandle,
        cwd: Option<String>,
        env: Option<std::collections::HashMap<String, String>>,
        metadata_store: MetadataStore,
        created_at: Instant,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        let mut cmd = CommandBuilder::new(command);
        cmd.args(args);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Keep the legacy TERM_PROGRAM for shell launcher compatibility.
        // The public app name is exposed separately via MYCMUX_TERM_PROGRAM.
        cmd.env("TERM_PROGRAM", "ptrterminal");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        cmd.env("MYCMUX_TERM_PROGRAM", "mycmux");

        if let Some(ref extra_env) = env {
            for (k, v) in extra_env {
                cmd.env(k, v);
            }
        }

        if let Some(dir) = cwd {
            if std::path::Path::new(&dir).is_dir() {
                cmd.cwd(dir);
            } else if let Some(home) = dirs::home_dir() {
                cmd.cwd(home);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {e}"))?;

        // Drop slave — we only need master
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

        // Dedicated writer thread: owns the PTY writer and drains a bounded
        // FIFO queue. A blocked ConPTY never blocks the Tauri command thread;
        // producers receive retryable backpressure instead.
        let (write_tx, mut write_rx) = mpsc::channel::<QueuedInput>(INPUT_QUEUE_MESSAGE_CAP);
        let write_pending_bytes = Arc::new(AtomicUsize::new(0));
        let writer_failed = Arc::new(AtomicBool::new(false));
        let writer_failed_thread = writer_failed.clone();
        let writer_failed_session_id = session_id.clone();
        thread::spawn(move || {
            let mut writer = writer;
            while let Some(input) = write_rx.blocking_recv() {
                let mut broken = false;
                // Chunk writes to avoid PTY buffer overflow (conpty ~4KB limit).
                for chunk in input.data.chunks(INPUT_WRITE_CHUNK_BYTES) {
                    if writer.write_all(chunk).is_err() || writer.flush().is_err() {
                        broken = true;
                        break;
                    }
                }
                if broken {
                    writer_failed_thread.store(true, Ordering::Release);
                    // Fires at most once per session: `write` short-circuits on
                    // `writer_failed` and this thread exits immediately.
                    crate::diag_warn!(
                        "pty",
                        "session {writer_failed_session_id} input writer broke; terminal input is dead"
                    );
                    break;
                }
            }
        });

        // Create broadcast channel and scrollback for remote clients
        let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
        let scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAP)));
        let scrollback_end = Arc::new(AtomicU64::new(0));
        let last_output_at = Arc::new(AtomicU64::new(0));
        let session_epoch = next_session_epoch();
        let broadcast_tx_clone = broadcast_tx.clone();
        let sb_clone = scrollback.clone();
        let sb_end_clone = scrollback_end.clone();
        let last_output_at_reader = last_output_at.clone();
        let (frontend_tx, mut frontend_rx) = mpsc::channel::<FrontendChunk>(FRONTEND_QUEUE_CAP);
        let frontend_flow = Arc::new(FrontendFlow::new(data_channel));

        // v0.7.1 diag: per-session counters shared by reader/forwarder.
        let metrics = Arc::new(PtyMetrics::default());

        // v0.7.1 diag: periodic metrics flush to stderr — DEBUG BUILDS ONLY.
        // Release skips spawning this entirely, removing the per-session 5 s
        // stderr output and the prior never-terminating task leak: this loop had
        // no exit condition, so one task per session lingered forever across
        // open/close churn. Debug keeps it for diagnostics.
        #[cfg(debug_assertions)]
        {
            let metrics_for_log = metrics.clone();
            let sid_for_log = session_id.clone();
            tauri::async_runtime::spawn(async move {
                use std::sync::atomic::Ordering;
                let mut prev_reads: u64 = 0;
                loop {
                    tokio::time::sleep(Duration::from_millis(METRICS_FLUSH_INTERVAL_MS)).await;
                    let reads = metrics_for_log.reads.load(Ordering::Relaxed);
                    if reads == prev_reads {
                        continue;
                    }
                    let micros = metrics_for_log.read_micros_total.load(Ordering::Relaxed);
                    let flushes = metrics_for_log.flushes.load(Ordering::Relaxed);
                    let flushed_bytes = metrics_for_log.flushed_bytes.load(Ordering::Relaxed);
                    let send_err = metrics_for_log.channel_send_errors.load(Ordering::Relaxed);
                    let queue_full = metrics_for_log
                        .frontend_queue_full_retry
                        .load(Ordering::Relaxed);
                    let dropped_c = metrics_for_log.dropped_chunks.load(Ordering::Relaxed);
                    let dropped_b = metrics_for_log.dropped_bytes.load(Ordering::Relaxed);
                    let autoconsume = metrics_for_log.autoconsume_events.load(Ordering::Relaxed);
                    let closed = metrics_for_log.closed_count.load(Ordering::Relaxed);
                    let avg_read_us = micros.checked_div(reads).unwrap_or(0);
                    let avg_batch = flushed_bytes.checked_div(flushes).unwrap_or(0);
                    eprintln!(
                    "[mycmux-diag pty {}] reads={} avg_read_us={} flushes={} avg_batch={} send_err={} queue_full={} dropped_chunks={} dropped_bytes={} autoconsume={} closed={}",
                    sid_for_log,
                    reads,
                    avg_read_us,
                    flushes,
                    avg_batch,
                    send_err,
                    queue_full,
                    dropped_c,
                    dropped_b,
                    autoconsume,
                    closed,
                );
                    prev_reads = reads;
                }
            });
        }

        let metrics_forwarder = metrics.clone();
        let forwarder_flow = frontend_flow.clone();
        tauri::async_runtime::spawn(async move {
            use std::sync::atomic::Ordering;
            let mut carry: Option<FrontendChunk> = None;
            loop {
                let first_chunk = match carry.take() {
                    Some(chunk) => chunk,
                    None => match frontend_rx.recv().await {
                        Some(chunk) => chunk,
                        None => break,
                    },
                };
                let mut batch = first_chunk.data;
                let scrollback_start = first_chunk.scrollback_start;
                let mut scrollback_end = first_chunk.scrollback_end;

                while batch.len() < FRONTEND_BATCH_MAX_BYTES {
                    match frontend_rx.try_recv() {
                        Ok(chunk) => {
                            if chunk.scrollback_start != scrollback_end {
                                carry = Some(chunk);
                                break;
                            }
                            batch.extend_from_slice(&chunk.data);
                            scrollback_end = chunk.scrollback_end;
                        }
                        Err(mpsc::error::TryRecvError::Empty) => break,
                        Err(mpsc::error::TryRecvError::Disconnected) => break,
                    }
                }

                let batch_len = batch.len();
                match forwarder_flow.reserve(batch_len).await {
                    FlowPermit::Closed => break,
                    FlowPermit::AutoConsume => {
                        metrics_forwarder
                            .autoconsume_events
                            .fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    FlowPermit::Send {
                        generation,
                        seq,
                        resync,
                    } => {
                        let msg = FrontendDataBatch {
                            generation,
                            seq,
                            resync,
                            scrollback_start,
                            scrollback_end,
                            data: batch,
                        };
                        match forwarder_flow.send_batch(msg) {
                            Ok(()) => {
                                metrics_forwarder.flushes.fetch_add(1, Ordering::Relaxed);
                                metrics_forwarder
                                    .flushed_bytes
                                    .fetch_add(batch_len as u64, Ordering::Relaxed);
                            }
                            Err(FlowSendError::Closed) => break,
                            Err(FlowSendError::Replaced | FlowSendError::Disconnected) => {
                                forwarder_flow.cancel(generation, seq);
                                metrics_forwarder
                                    .channel_send_errors
                                    .fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                }
                if batch_len < FRONTEND_BATCH_MAX_BYTES {
                    tokio::time::sleep(Duration::from_millis(FRONTEND_FLUSH_INTERVAL_MS)).await;
                } else {
                    tokio::time::sleep(Duration::from_millis(FRONTEND_SATURATED_FLUSH_INTERVAL_MS))
                        .await;
                }
            }
        });

        // Spawn reader thread — blocking I/O, not tokio
        let sid = session_id.clone();
        let handle = app_handle.clone();
        let metrics_reader = metrics.clone();
        let reader_flow = frontend_flow.clone();
        thread::spawn(move || {
            use std::sync::atomic::Ordering;
            let mut buf = [0u8; 4096]; // 4KB — matches OS page size
            let mut osc7 = Osc7Parser::new();
            let mut frontend_open = true;
            loop {
                let read_start = Instant::now();
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        record_last_output_at(&last_output_at_reader, epoch_millis());
                        let read_micros = read_start.elapsed().as_micros();
                        metrics_reader.reads.fetch_add(1, Ordering::Relaxed);
                        metrics_reader
                            .read_micros_total
                            .fetch_add(read_micros as u64, Ordering::Relaxed);

                        // OSC 7: side-channel CWD observation. Bytes are NOT stripped —
                        // xterm.js ignores unknown OSCs, so passing them through is safe.
                        if let Some(cwd_raw) = osc7.feed(&buf[..n]) {
                            let cwd = cwd_raw
                                .trim_end_matches(['\n', '\r'])
                                .trim_end_matches('/')
                                .to_string();
                            if !cwd.is_empty() {
                                let prev = metadata_store.get(&sid).map(|m| m.clone());
                                let should_emit = match &prev {
                                    Some(m) => m.cwd != cwd,
                                    None => true,
                                };
                                if should_emit {
                                    let meta = match prev {
                                        Some(old) => PtyMetadata {
                                            session_id: sid.clone(),
                                            cwd: cwd.clone(),
                                            git_branch: old.git_branch.clone(),
                                            process_name: old.process_name.clone(),
                                            process_status: old.process_status.clone(),
                                            process_status_at: old.process_status_at,
                                            last_output_at: old.last_output_at,
                                            agent_active: old.agent_active,
                                            claude_session_id: old.claude_session_id.clone(),
                                            agent_kind: old.agent_kind.clone(),
                                            agent_session_id: old.agent_session_id.clone(),
                                        },
                                        None => PtyMetadata {
                                            session_id: sid.clone(),
                                            cwd: cwd.clone(),
                                            git_branch: None,
                                            process_name: None,
                                            process_status: None,
                                            process_status_at: None,
                                            last_output_at: None,
                                            agent_active: false,
                                            claude_session_id: None,
                                            agent_kind: None,
                                            agent_session_id: None,
                                        },
                                    };
                                    metadata_store.insert(sid.clone(), meta.clone());
                                    let _ = handle.emit("pty_metadata", meta);
                                }
                            }
                        }

                        #[cfg(debug_assertions)]
                        let send_start = Instant::now();
                        let chunk = buf[..n].to_vec();

                        // Append before publishing the frontend batch. The
                        // absolute offsets let a recovering renderer discard
                        // exactly the bytes already present in its snapshot.
                        let scrollback_start = sb_end_clone.load(Ordering::Relaxed);
                        let scrollback_end = scrollback_start.saturating_add(chunk.len() as u64);
                        if let Ok(mut sb) = sb_clone.lock() {
                            sb.extend(chunk.iter().copied());
                            let overflow = sb.len().saturating_sub(SCROLLBACK_CAP);
                            if overflow > 0 {
                                drop(sb.drain(..overflow));
                            }
                            sb_end_clone.store(scrollback_end, Ordering::Relaxed);
                        }
                        if frontend_open {
                            match frontend_tx.try_send(FrontendChunk {
                                data: chunk.clone(),
                                scrollback_start,
                                scrollback_end,
                            }) {
                                Ok(()) => {}
                                Err(mpsc::error::TrySendError::Full(rejected)) => {
                                    reader_flow.mark_dropped();
                                    metrics_reader
                                        .frontend_queue_full_retry
                                        .fetch_add(1, Ordering::Relaxed);
                                    metrics_reader
                                        .dropped_chunks
                                        .fetch_add(1, Ordering::Relaxed);
                                    metrics_reader
                                        .dropped_bytes
                                        .fetch_add(rejected.data.len() as u64, Ordering::Relaxed);
                                    // Keep draining the PTY even when the renderer is behind.
                                    // Blocking here lets child stdout/stderr fill up and can make
                                    // stdin appear frozen, so display catch-up is best-effort.
                                }
                                Err(mpsc::error::TrySendError::Closed(_)) => {
                                    metrics_reader.closed_count.fetch_add(1, Ordering::Relaxed);
                                    frontend_open = false;
                                }
                            }
                        }
                        #[cfg(debug_assertions)]
                        let send_micros = send_start.elapsed().as_micros();

                        // Also send to broadcast for remote clients.
                        if broadcast_tx_clone.receiver_count() > 0 {
                            let _ = broadcast_tx_clone.send(chunk.clone());
                        }
                        #[cfg(debug_assertions)]
                        {
                            // Log slow reads in debug builds only
                            if read_micros > 1000 || send_micros > 1000 {
                                eprintln!(
                                    "[PERF] PTY read: {}μs, channel send: {}μs, bytes: {}",
                                    read_micros, send_micros, n
                                );
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let exit_event = events::pty_exit_event(&sid);
            let _ = handle.emit(&exit_event, ());
        });

        Ok(Self {
            child: Mutex::new(child),
            master: Mutex::new(pair.master),
            write_tx,
            write_pending_bytes,
            writer_failed,
            broadcast: broadcast_tx,
            scrollback,
            scrollback_end,
            last_output_at,
            session_epoch,
            frontend_flow,
            created_at,
            metrics,
        })
    }

    pub fn replace_data_channel(
        &self,
        data_channel: Channel<InvokeResponseBody>,
    ) -> Result<(String, String), String> {
        self.frontend_flow.replace_channel(data_channel)
    }

    pub fn ack_frontend_data(&self, generation: u64, seq: u64, bytes: usize) {
        self.frontend_flow.ack(generation, seq, bytes);
    }

    pub fn set_frontend_visible(&self, visible: bool) {
        self.frontend_flow.set_visible(visible);
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        // Reserve bytes before the non-blocking enqueue. QueuedInput::drop
        // releases the reservation after either consumption or rejection.
        if data.is_empty() {
            return Ok(());
        }
        if self.writer_failed.load(Ordering::Acquire) {
            return Err("PTY_INPUT_WRITER_FAILED: PTY writer thread has exited".to_string());
        }

        let bytes = data.len();
        self.write_pending_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                pending
                    .checked_add(bytes)
                    .filter(|next| *next <= INPUT_QUEUE_BYTE_CAP)
            })
            .map_err(|_| {
                "PTY_INPUT_BACKPRESSURE: terminal input queue byte limit reached".to_string()
            })?;

        let input = QueuedInput {
            data: data.to_vec(),
            pending_bytes: self.write_pending_bytes.clone(),
        };
        match self.write_tx.try_send(input) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                Err("PTY_INPUT_BACKPRESSURE: terminal input queue is full".to_string())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.writer_failed.store(true, Ordering::Release);
                // Fires at most once per session: the guard above short-circuits
                // every later write once `writer_failed` is set.
                crate::diag_warn!(
                    "pty",
                    "input queue closed for session epoch {}; terminal input is dead",
                    self.session_epoch
                );
                Err("PTY_INPUT_WRITER_FAILED: PTY writer thread has exited".to_string())
            }
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self
            .master
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {e}"))
    }

    pub fn kill(&self) -> Result<(), String> {
        self.frontend_flow.close();
        let mut child = self.child.lock().map_err(|e| format!("Lock failed: {e}"))?;
        child.kill().map_err(|e| format!("Kill failed: {e}"))
    }

    pub fn process_id(&self) -> Option<u32> {
        if let Ok(child) = self.child.lock() {
            child.process_id()
        } else {
            None
        }
    }

    pub fn get_scrollback(&self) -> Vec<u8> {
        self.scrollback
            .lock()
            .map(|sb| sb.iter().copied().collect())
            .unwrap_or_default()
    }

    pub fn get_scrollback_snapshot(&self) -> ScrollbackSnapshot {
        match self.scrollback.lock() {
            Ok(scrollback) => {
                let data: Vec<u8> = scrollback.iter().copied().collect();
                let end_offset = self.scrollback_end.load(Ordering::Relaxed);
                let start_offset = end_offset.saturating_sub(data.len() as u64);
                ScrollbackSnapshot {
                    data,
                    start_offset,
                    end_offset,
                }
            }
            Err(_) => ScrollbackSnapshot {
                data: Vec::new(),
                start_offset: 0,
                end_offset: 0,
            },
        }
    }

    pub fn last_output_at(&self) -> Option<u64> {
        read_last_output_at(&self.last_output_at)
    }

    pub fn session_epoch(&self) -> u64 {
        self.session_epoch
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.frontend_flow.close();
        let _ = self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_output_at_starts_empty_and_tracks_latest_output() {
        let last_output_at = AtomicU64::new(0);
        assert_eq!(read_last_output_at(&last_output_at), None);

        record_last_output_at(&last_output_at, 1_725_000_000_123);
        assert_eq!(read_last_output_at(&last_output_at), Some(1_725_000_000_123));

        record_last_output_at(&last_output_at, 1_725_000_000_456);
        assert_eq!(read_last_output_at(&last_output_at), Some(1_725_000_000_456));
    }

    #[test]
    #[ignore = "manual release-mode throughput gate"]
    fn bench_last_output_at_update_overhead() {
        const ITERATIONS: usize = 25_000;
        const CHUNK_BYTES: usize = 4096;
        const ROUNDS: usize = 7;

        fn run(track_output: bool) -> Duration {
            let input = [b'x'; CHUNK_BYTES];
            let reads = AtomicU64::new(0);
            let scrollback_end = AtomicU64::new(0);
            let last_output_at = AtomicU64::new(0);
            let scrollback = Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAP));
            let started = Instant::now();
            for _ in 0..ITERATIONS {
                reads.fetch_add(1, Ordering::Relaxed);
                if track_output {
                    record_last_output_at(&last_output_at, epoch_millis());
                }
                let chunk = std::hint::black_box(&input).to_vec();
                let start = scrollback_end.load(Ordering::Relaxed);
                if let Ok(mut buffer) = scrollback.lock() {
                    buffer.extend(chunk.iter().copied());
                    let overflow = buffer.len().saturating_sub(SCROLLBACK_CAP);
                    if overflow > 0 {
                        drop(buffer.drain(..overflow));
                    }
                    scrollback_end.store(
                        start.saturating_add(chunk.len() as u64),
                        Ordering::Relaxed,
                    );
                }
                std::hint::black_box(scrollback_end.load(Ordering::Relaxed));
            }
            std::hint::black_box(reads.load(Ordering::Relaxed));
            std::hint::black_box(last_output_at.load(Ordering::Relaxed));
            started.elapsed()
        }

        let _ = run(false);
        let _ = run(true);
        let mut baseline = Vec::with_capacity(ROUNDS);
        let mut tracked = Vec::with_capacity(ROUNDS);
        for round in 0..ROUNDS {
            if round % 2 == 0 {
                baseline.push(run(false));
                tracked.push(run(true));
            } else {
                tracked.push(run(true));
                baseline.push(run(false));
            }
        }
        baseline.sort_unstable();
        tracked.sort_unstable();
        let baseline_seconds = baseline[ROUNDS / 2].as_secs_f64();
        let tracked_seconds = tracked[ROUNDS / 2].as_secs_f64();
        let mib = (ITERATIONS * CHUNK_BYTES) as f64 / (1024.0 * 1024.0);
        let baseline_mib_s = mib / baseline_seconds;
        let tracked_mib_s = mib / tracked_seconds;
        let delta_percent = (tracked_mib_s / baseline_mib_s - 1.0) * 100.0;
        println!(
            "lastOutputAt throughput: baseline={baseline_mib_s:.1} MiB/s tracked={tracked_mib_s:.1} MiB/s delta={delta_percent:+.2}%"
        );
    }

    fn test_channel() -> Channel<InvokeResponseBody> {
        Channel::new(|_| Ok(()))
    }

    fn expect_send(permit: FlowPermit) -> (u64, u64) {
        let (generation, seq, _) = expect_send_with_resync(permit);
        (generation, seq)
    }

    fn expect_send_with_resync(permit: FlowPermit) -> (u64, u64, bool) {
        match permit {
            FlowPermit::Send {
                generation,
                seq,
                resync,
            } => (generation, seq, resync),
            FlowPermit::AutoConsume => panic!("expected Send permit, got AutoConsume"),
            FlowPermit::Closed => panic!("expected Send permit, got Closed"),
        }
    }

    fn assert_auto_consume(permit: FlowPermit) {
        match permit {
            FlowPermit::AutoConsume => {}
            FlowPermit::Send { .. } => panic!("expected AutoConsume permit, got Send"),
            FlowPermit::Closed => panic!("expected AutoConsume permit, got Closed"),
        }
    }

    fn force_expire_inflight(flow: &FrontendFlow) {
        let mut st = flow.inner.lock().expect("flow lock poisoned");
        for item in st.inflight.iter_mut() {
            item.sent_at = Instant::now() - FRONTEND_ACK_TIMEOUT - Duration::from_millis(1);
        }
    }

    fn flow_snapshot(flow: &FrontendFlow) -> (u64, u64, usize, usize, bool, u32) {
        let st = flow.inner.lock().expect("flow lock poisoned");
        (
            st.generation,
            st.next_seq,
            st.inflight_bytes,
            st.inflight.len(),
            st.attached,
            st.stale_timeouts,
        )
    }

    #[tokio::test]
    async fn reserve_sends_under_low_backlog_and_blocks_when_limits_are_exceeded() {
        let flow = FrontendFlow::new(test_channel());

        let (generation, seq) = expect_send(flow.reserve(128).await);
        assert_eq!((generation, seq), (1, 1));
        assert_eq!(flow_snapshot(&flow), (1, 2, 128, 1, true, 0));

        let oversized = tokio::time::timeout(
            Duration::from_millis(50),
            flow.reserve(FRONTEND_MAX_INFLIGHT_BYTES + 1),
        )
        .await;
        assert!(oversized.is_err(), "oversized reserve should block");

        flow.ack(generation, seq, 128);
        for _ in 0..FRONTEND_MAX_INFLIGHT_BATCHES {
            expect_send(flow.reserve(1).await);
        }
        let too_many_batches =
            tokio::time::timeout(Duration::from_millis(50), flow.reserve(1)).await;
        assert!(
            too_many_batches.is_err(),
            "reserve over the in-flight batch cap should block"
        );
    }

    #[tokio::test]
    async fn ack_from_stale_generation_is_ignored() {
        let flow = FrontendFlow::new(test_channel());
        let (old_generation, old_seq) = expect_send(flow.reserve(256).await);
        flow.replace_channel(test_channel())
            .expect("replace channel");

        flow.ack(old_generation, old_seq, 256);

        assert_eq!(flow_snapshot(&flow), (2, 1, 0, 0, true, 0));
    }

    #[tokio::test]
    async fn ack_from_current_generation_releases_inflight_and_resets_stale_bookkeeping() {
        let flow = FrontendFlow::new(test_channel());
        let (generation, seq1) = expect_send(flow.reserve(100).await);
        let (_, seq2) = expect_send(flow.reserve(200).await);
        {
            let mut st = flow.inner.lock().expect("flow lock poisoned");
            st.stale_timeouts = 1;
        }

        flow.ack(generation, seq2, 200);

        assert_eq!(seq1, 1);
        assert_eq!(flow_snapshot(&flow), (1, 3, 0, 0, true, 0));
    }

    #[tokio::test]
    async fn cancel_keeps_channel_detached_after_late_matching_ack() {
        let flow = FrontendFlow::new(test_channel());
        let (generation, seq) = expect_send(flow.reserve(64).await);

        flow.cancel(generation, seq);
        assert_eq!(
            flow_snapshot(&flow),
            (1, 2, 0, 0, false, FRONTEND_STALE_TIMEOUTS)
        );
        flow.ack(generation, seq, 64);
        assert_eq!(flow_snapshot(&flow), (1, 2, 0, 0, false, 0));
        assert_auto_consume(flow.reserve(64).await);
        flow.ack(generation, seq, 64);
        assert_eq!(flow_snapshot(&flow), (1, 2, 0, 0, false, 0));

        let (old_channel_id, new_channel_id) = flow
            .replace_channel(test_channel())
            .expect("replace channel after cancel");
        assert_ne!(old_channel_id, new_channel_id);
        assert_eq!(flow_snapshot(&flow), (2, 1, 0, 0, true, 0));

        flow.ack(generation, seq, 64);
        assert_eq!(flow_snapshot(&flow), (2, 1, 0, 0, true, 0));
    }

    #[tokio::test]
    async fn stale_timeout_recovers_after_late_current_generation_ack() {
        let flow = FrontendFlow::new(test_channel());
        let (generation, seq1) = expect_send(flow.reserve(32).await);

        force_expire_inflight(&flow);
        let (_, seq2) = expect_send(flow.reserve(32).await);
        assert_eq!(flow_snapshot(&flow), (1, 3, 32, 1, true, 1));

        force_expire_inflight(&flow);
        assert_auto_consume(flow.reserve(32).await);
        assert_eq!(
            flow_snapshot(&flow),
            (1, 3, 0, 0, true, FRONTEND_STALE_TIMEOUTS)
        );

        flow.ack(generation, seq1, 32);
        flow.ack(generation, seq2, 32);
        let recovered = expect_send(flow.reserve(32).await);
        assert_eq!(recovered, (1, 3));
        assert_eq!(flow_snapshot(&flow), (1, 4, 32, 1, true, 0));
    }

    #[tokio::test]
    async fn autoconsume_marks_next_send_for_single_resync() {
        let flow = FrontendFlow::new(test_channel());
        let (generation, seq1, first_resync) = expect_send_with_resync(flow.reserve(32).await);
        assert_eq!((generation, seq1, first_resync), (1, 1, false));

        force_expire_inflight(&flow);
        let (_, seq2, second_resync) = expect_send_with_resync(flow.reserve(32).await);
        assert_eq!((seq2, second_resync), (2, false));

        force_expire_inflight(&flow);
        assert_auto_consume(flow.reserve(32).await);

        flow.ack(generation, seq1, 32);
        flow.ack(generation, seq2, 32);
        let (recovered_generation, seq3, resync) = expect_send_with_resync(flow.reserve(32).await);
        assert_eq!((recovered_generation, seq3, resync), (1, 3, true));

        flow.ack(recovered_generation, seq3, 32);
        let (_, seq4, resync) = expect_send_with_resync(flow.reserve(32).await);
        assert_eq!((seq4, resync), (4, false));
    }

    #[tokio::test]
    async fn dropped_frontend_chunk_marks_exactly_one_following_batch_for_resync() {
        let flow = FrontendFlow::new(test_channel());
        let (generation, seq1, resync1) = expect_send_with_resync(flow.reserve(16).await);
        assert!(!resync1);
        flow.ack(generation, seq1, 16);

        flow.mark_dropped();
        let (_, seq2, resync2) = expect_send_with_resync(flow.reserve(16).await);
        assert!(resync2);
        flow.ack(generation, seq2, 16);

        let (_, _, resync3) = expect_send_with_resync(flow.reserve(16).await);
        assert!(!resync3);
    }

    #[test]
    fn binary_frames_keep_terminal_payload_bytes_raw() {
        let data_frame = FrontendDataBatch {
            generation: 2,
            seq: 7,
            resync: true,
            scrollback_start: 100,
            scrollback_end: 103,
            data: vec![65, 66, 67],
        }
        .into_wire();
        assert_eq!(&data_frame[..4], b"MCX1");
        assert_eq!(data_frame.len(), FRONTEND_DATA_FRAME_HEADER_BYTES + 3);
        assert_eq!(&data_frame[40..], &[65, 66, 67]);

        let snapshot_frame = ScrollbackSnapshot {
            data: vec![10, 11],
            start_offset: 40,
            end_offset: 42,
        }
        .into_wire();
        assert_eq!(&snapshot_frame[..4], b"MCS1");
        assert_eq!(snapshot_frame.len(), SCROLLBACK_FRAME_HEADER_BYTES + 2);
        assert_eq!(&snapshot_frame[24..], &[10, 11]);
    }

    #[test]
    fn queued_input_releases_reserved_bytes_when_consumed_or_rejected() {
        let pending = Arc::new(AtomicUsize::new(3));
        {
            let _input = QueuedInput {
                data: vec![1, 2, 3],
                pending_bytes: pending.clone(),
            };
            assert_eq!(pending.load(Ordering::Acquire), 3);
        }
        assert_eq!(pending.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn set_visible_true_recovers_stale_autoconsume_state() {
        let flow = FrontendFlow::new(test_channel());
        expect_send(flow.reserve(32).await);

        force_expire_inflight(&flow);
        expect_send(flow.reserve(32).await);
        force_expire_inflight(&flow);
        assert_auto_consume(flow.reserve(32).await);
        assert_eq!(
            flow_snapshot(&flow),
            (1, 3, 0, 0, true, FRONTEND_STALE_TIMEOUTS)
        );

        flow.set_visible(true);

        let recovered = expect_send(flow.reserve(32).await);
        assert_eq!(recovered, (1, 3));
        assert_eq!(flow_snapshot(&flow), (1, 4, 32, 1, true, 0));
    }
}
