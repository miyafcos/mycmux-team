use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::events;

use super::monitor::{MetadataStore, PtyMetadata};
use super::osc7::Osc7Parser;

use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Notify};

const SCROLLBACK_CAP: usize = 32 * 1024; // 32 KB
const FRONTEND_QUEUE_CAP: usize = 4096;
const FRONTEND_FLUSH_INTERVAL_MS: u64 = 4;
const FRONTEND_BATCH_MAX_BYTES: usize = 64 * 1024;
const FRONTEND_MAX_INFLIGHT_BYTES: usize = 512 * 1024;
const FRONTEND_LOW_WATER_BYTES: usize = 256 * 1024;
const FRONTEND_MAX_INFLIGHT_BATCHES: usize = 16;
const FRONTEND_ACK_TIMEOUT: Duration = Duration::from_millis(2500);
const FRONTEND_STALE_TIMEOUTS: u32 = 2;
// v0.7.1 diag: report aggregated PTY metrics every 5 s on stderr.
const METRICS_FLUSH_INTERVAL_MS: u64 = 5_000;

// v0.7.1 diag: per-session counters shared by reader/forwarder threads.
// Used only for stderr reports; no behavior change.
#[derive(Default)]
pub(crate) struct PtyMetrics {
    pub reads: std::sync::atomic::AtomicU64,
    pub read_micros_total: std::sync::atomic::AtomicU64,
    pub flushes: std::sync::atomic::AtomicU64,
    pub flushed_bytes: std::sync::atomic::AtomicU64,
    pub channel_send_errors: std::sync::atomic::AtomicU64,
    pub frontend_queue_full_retry: std::sync::atomic::AtomicU64,
    pub dropped_chunks: std::sync::atomic::AtomicU64,
    pub dropped_bytes: std::sync::atomic::AtomicU64,
    pub closed_count: std::sync::atomic::AtomicU64,
}

#[derive(Clone, serde::Serialize)]
pub struct FrontendDataBatch {
    pub generation: u64,
    pub seq: u64,
    pub bytes: usize,
    pub data: Vec<u8>,
}

struct InFlight {
    generation: u64,
    seq: u64,
    bytes: usize,
    sent_at: Instant,
}

struct FrontendFlowState {
    data_channel: Channel<FrontendDataBatch>,
    generation: u64,
    next_seq: u64,
    inflight_bytes: usize,
    inflight: VecDeque<InFlight>,
    attached: bool,
    visible: bool,
    stale_timeouts: u32,
    closing: bool,
}

struct FrontendFlow {
    inner: Mutex<FrontendFlowState>,
    notify: Notify,
}

enum FlowPermit {
    Send { generation: u64, seq: u64 },
    AutoConsume,
    Closed,
}

enum FlowSendError {
    Replaced,
    Closed,
    Disconnected,
}

impl FrontendFlow {
    fn new(data_channel: Channel<FrontendDataBatch>) -> Self {
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
                    return FlowPermit::AutoConsume;
                }
                Self::forgive_expired_locked(&mut st);
                if st.stale_timeouts >= FRONTEND_STALE_TIMEOUTS {
                    return FlowPermit::AutoConsume;
                }
                let under_bytes =
                    st.inflight_bytes.saturating_add(bytes) <= FRONTEND_MAX_INFLIGHT_BYTES;
                let under_batches = st.inflight.len() < FRONTEND_MAX_INFLIGHT_BATCHES;
                if under_bytes && under_batches {
                    let seq = st.next_seq;
                    st.next_seq = st.next_seq.saturating_add(1);
                    let generation = st.generation;
                    st.inflight_bytes = st.inflight_bytes.saturating_add(bytes);
                    st.inflight.push_back(InFlight {
                        generation,
                        seq,
                        bytes,
                        sent_at: Instant::now(),
                    });
                    return FlowPermit::Send { generation, seq };
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
        let st = self.inner.lock().map_err(|_| FlowSendError::Closed)?;
        if st.closing {
            return Err(FlowSendError::Closed);
        }
        if batch.generation != st.generation {
            return Err(FlowSendError::Replaced);
        }
        st.data_channel
            .send(batch)
            .map_err(|_| FlowSendError::Disconnected)
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
        if generation != st.generation || st.closing || st.stale_timeouts >= FRONTEND_STALE_TIMEOUTS
        {
            return;
        }
        let mut acked = false;
        while let Some(front) = st.inflight.front() {
            if front.generation != generation || front.seq > seq {
                break;
            }
            let item = st.inflight.pop_front().unwrap();
            st.inflight_bytes = st.inflight_bytes.saturating_sub(item.bytes);
            acked = true;
        }
        if acked {
            st.stale_timeouts = 0;
        }
        if st.inflight_bytes <= FRONTEND_LOW_WATER_BYTES {
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
        data_channel: Channel<FrontendDataBatch>,
    ) -> Result<(String, String), String> {
        let mut st = self
            .inner
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
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
        self.notify.notify_waiters();
        Ok((old_channel_id, new_channel_id))
    }

    fn set_visible(&self, visible: bool) {
        let Ok(mut st) = self.inner.lock() else {
            return;
        };
        st.visible = visible;
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
    writer: Mutex<Box<dyn Write + Send>>,
    pub broadcast: broadcast::Sender<Vec<u8>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
    frontend_flow: Arc<FrontendFlow>,
    pub created_at: Instant,
    #[allow(dead_code)]
    pub(crate) metrics: Arc<PtyMetrics>,
}

// Safety: All fields are behind Mutex, access is serialized.
unsafe impl Sync for PtySession {}

impl PtySession {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        session_id: String,
        command: &str,
        args: &[String],
        cols: u16,
        rows: u16,
        data_channel: Channel<FrontendDataBatch>,
        _consumer_id: String,
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

        #[cfg(target_os = "windows")]
        crate::pty::windows_console::suppress_spawn_flash(std::process::id());

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

        // Create broadcast channel and scrollback for remote clients
        let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
        let scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAP)));
        let broadcast_tx_clone = broadcast_tx.clone();
        let sb_clone = scrollback.clone();
        let (frontend_tx, mut frontend_rx) = mpsc::channel::<Vec<u8>>(FRONTEND_QUEUE_CAP);
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
                    let closed = metrics_for_log.closed_count.load(Ordering::Relaxed);
                    let avg_read_us = if reads > 0 { micros / reads } else { 0 };
                    let avg_batch = if flushes > 0 {
                        flushed_bytes / flushes
                    } else {
                        0
                    };
                    eprintln!(
                    "[mycmux-diag pty {}] reads={} avg_read_us={} flushes={} avg_batch={} send_err={} queue_full={} dropped_chunks={} dropped_bytes={} closed={}",
                    sid_for_log,
                    reads,
                    avg_read_us,
                    flushes,
                    avg_batch,
                    send_err,
                    queue_full,
                    dropped_c,
                    dropped_b,
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
            while let Some(first_chunk) = frontend_rx.recv().await {
                let mut batch = first_chunk;

                while batch.len() < FRONTEND_BATCH_MAX_BYTES {
                    match frontend_rx.try_recv() {
                        Ok(chunk) => batch.extend_from_slice(&chunk),
                        Err(mpsc::error::TryRecvError::Empty) => break,
                        Err(mpsc::error::TryRecvError::Disconnected) => break,
                    }
                }

                let batch_len = batch.len();
                match forwarder_flow.reserve(batch_len).await {
                    FlowPermit::Closed => break,
                    FlowPermit::AutoConsume => continue,
                    FlowPermit::Send { generation, seq } => {
                        let msg = FrontendDataBatch {
                            generation,
                            seq,
                            bytes: batch_len,
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
                    tokio::task::yield_now().await;
                }
            }
        });

        // Spawn reader thread — blocking I/O, not tokio
        let sid = session_id.clone();
        let handle = app_handle.clone();
        let metrics_reader = metrics.clone();
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
                                            claude_session_id: old.claude_session_id.clone(),
                                            agent_kind: old.agent_kind.clone(),
                                            agent_session_id: old.agent_session_id.clone(),
                                        },
                                        None => PtyMetadata {
                                            session_id: sid.clone(),
                                            cwd: cwd.clone(),
                                            git_branch: None,
                                            process_name: None,
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

                        let send_start = Instant::now();
                        let chunk = buf[..n].to_vec();
                        if frontend_open {
                            match frontend_tx.try_send(chunk.clone()) {
                                Ok(()) => {}
                                Err(mpsc::error::TrySendError::Full(rejected)) => {
                                    metrics_reader
                                        .frontend_queue_full_retry
                                        .fetch_add(1, Ordering::Relaxed);
                                    if frontend_tx.blocking_send(rejected).is_err() {
                                        metrics_reader.closed_count.fetch_add(1, Ordering::Relaxed);
                                        frontend_open = false;
                                    }
                                }
                                Err(mpsc::error::TrySendError::Closed(_)) => {
                                    metrics_reader.closed_count.fetch_add(1, Ordering::Relaxed);
                                    frontend_open = false;
                                }
                            }
                        }
                        let send_micros = send_start.elapsed().as_micros();

                        // Also send to broadcast for remote clients
                        let _ = broadcast_tx_clone.send(chunk.clone());
                        // Append to scrollback ring buffer
                        if let Ok(mut sb) = sb_clone.lock() {
                            sb.extend(chunk.iter().copied());
                            let overflow = sb.len().saturating_sub(SCROLLBACK_CAP);
                            if overflow > 0 {
                                drop(sb.drain(..overflow));
                            }
                        }

                        // Log slow reads in debug builds only
                        if cfg!(debug_assertions) && (read_micros > 1000 || send_micros > 1000) {
                            eprintln!(
                                "[PERF] PTY read: {}μs, channel send: {}μs, bytes: {}",
                                read_micros, send_micros, n
                            );
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
            writer: Mutex::new(writer),
            broadcast: broadcast_tx,
            scrollback,
            frontend_flow,
            created_at,
            metrics,
        })
    }

    pub fn replace_data_channel(
        &self,
        data_channel: Channel<FrontendDataBatch>,
        _consumer_id: String,
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
        let start = Instant::now();
        let mut writer = self
            .writer
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;

        let lock_micros = start.elapsed().as_micros();
        let write_start = Instant::now();

        // Chunk writes to avoid PTY buffer overflow (conpty ~4KB limit)
        for chunk in data.chunks(1024) {
            writer
                .write_all(chunk)
                .map_err(|e| format!("Write failed: {e}"))?;
            writer.flush().map_err(|e| format!("Flush failed: {e}"))?;
        }

        let write_micros = write_start.elapsed().as_micros();
        let total_micros = start.elapsed().as_micros();

        // Log slow writes in debug builds only
        if cfg!(debug_assertions) && total_micros > 1000 {
            eprintln!(
                "[PERF] PTY write: lock={}μs, write+flush={}μs, total={}μs, bytes={}",
                lock_micros,
                write_micros,
                total_micros,
                data.len()
            );
        }

        Ok(())
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
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.frontend_flow.close();
        let _ = self.kill();
    }
}
