use axum::extract::ws::{Message, WebSocket};
use axum::extract::{ConnectInfo, Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, Notify};

use super::RemoteState;
use crate::pty::session::{OutputChunk, ScrollbackSnapshot};

/// Scrollback chunk size (16 KB) to avoid freezing mobile clients.
const SCROLLBACK_CHUNK_SIZE: usize = 16 * 1024;
const REMOTE_BATCH_MAX_BYTES: usize = 64 * 1024;
const REMOTE_FLUSH_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WsMode {
    View,
    Control,
}

impl WsMode {
    fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("control") => WsMode::Control,
            _ => WsMode::View,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            WsMode::View => "view",
            WsMode::Control => "control",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SnapshotSourceKind {
    App,
    Remote,
}

pub(crate) fn client_resize_applies(mode: WsMode, source: SnapshotSourceKind) -> bool {
    match source {
        SnapshotSourceKind::Remote => true,
        SnapshotSourceKind::App => matches!(mode, WsMode::Control),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResumePayload {
    pub data: Vec<u8>,
    pub start: u64,
    pub end: u64,
    pub resync: bool,
}

fn full_resync_payload(data: &[u8], start: u64, end: u64) -> ResumePayload {
    ResumePayload {
        data: data.to_vec(),
        start,
        end,
        resync: true,
    }
}

fn snapshot_len_matches(data: &[u8], start: u64, end: u64) -> bool {
    end >= start && data.len() == (end - start) as usize
}

/// Choose a reconnect / live-catch-up payload from a scrollback snapshot
/// and the client's last received end offset. Out-of-range `since`
/// (including overflowed scrollback) and broken length invariants yield
/// the full snapshot with `resync: true`.
pub(crate) fn resume_from_snapshot(
    data: &[u8],
    start: u64,
    end: u64,
    since: Option<u64>,
) -> ResumePayload {
    if !snapshot_len_matches(data, start, end) {
        return full_resync_payload(data, start, end);
    }
    match since {
        Some(since) if since >= start && since <= end => {
            let skip = (since - start) as usize;
            match data.get(skip..) {
                Some(slice) => ResumePayload {
                    data: slice.to_vec(),
                    start: since,
                    end,
                    resync: false,
                },
                None => full_resync_payload(data, start, end),
            }
        }
        _ => full_resync_payload(data, start, end),
    }
}

/// Live catch-up after pause-drop or Lagged. Same window rule as reconnect.
pub(crate) fn catchup_from_snapshot(
    data: &[u8],
    start: u64,
    end: u64,
    last_sent_end: u64,
) -> ResumePayload {
    resume_from_snapshot(data, start, end, Some(last_sent_end))
}

/// Ignore `since` when the client epoch does not match the live PTY.
pub(crate) fn effective_since(
    since: Option<u64>,
    client_epoch: Option<u64>,
    server_epoch: Option<u64>,
) -> Option<u64> {
    match (since, client_epoch, server_epoch) {
        (None, _, _) => None,
        (Some(offset), _, None) => Some(offset),
        (Some(offset), Some(client), Some(server)) if client == server => Some(offset),
        _ => None,
    }
}

/// Remote-only shells go through the same epoch gate as App sessions.
/// Always carry the live epoch so the client can send it back on reconnect.
pub(crate) fn remote_session_connect_args(
    requested_since: Option<u64>,
    client_epoch: Option<u64>,
    server_epoch: u64,
) -> (Option<u64>, Option<u64>) {
    (
        effective_since(requested_since, client_epoch, Some(server_epoch)),
        Some(server_epoch),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TrimResult {
    Send(OutputChunk),
    Skip,
    NeedResync,
}

/// Drop bytes the client already has. Broken length / reversed ranges
/// ask the sender to resync instead of silently yielding an empty chunk.
pub(crate) fn trim_overlap(chunk: OutputChunk, already_have_end: u64) -> TrimResult {
    if chunk.end < chunk.start {
        return TrimResult::NeedResync;
    }
    if !snapshot_len_matches(&chunk.data, chunk.start, chunk.end) {
        return TrimResult::NeedResync;
    }
    if chunk.end <= already_have_end {
        return TrimResult::Skip;
    }
    if chunk.start >= already_have_end {
        return TrimResult::Send(chunk);
    }
    let skip = (already_have_end - chunk.start) as usize;
    match chunk.data.get(skip..) {
        Some(data) => TrimResult::Send(OutputChunk {
            data: data.to_vec(),
            start: already_have_end,
            end: chunk.end,
        }),
        None => TrimResult::NeedResync,
    }
}

#[derive(Deserialize)]
pub struct WsQuery {
    token: String,
    session: Option<String>,
    since: Option<u64>,
    epoch: Option<u64>,
    mode: Option<String>,
}

/// HTTP handler — upgrades to WebSocket after token validation.
pub async fn ws_upgrade(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !state.control.validate_token(&query.token).await {
        return (axum::http::StatusCode::UNAUTHORIZED, "Invalid token").into_response();
    }
    ws.on_upgrade(move |socket| handle_ws(socket, state, query, peer_addr.to_string()))
        .into_response()
}

async fn handle_ws(socket: WebSocket, state: Arc<RemoteState>, query: WsQuery, peer_addr: String) {
    let session_param = query.session.as_deref().unwrap_or("");
    let mode = WsMode::parse(query.mode.as_deref());
    let requested_since = query.since;
    let client_epoch = query.epoch;
    let initial_session_id = if session_param.is_empty() || session_param == "new" {
        None
    } else {
        Some(session_param.to_string())
    };
    let client_id = state.control.register_client(peer_addr, initial_session_id);

    // Explicit "new" → create a fresh remote shell
    if session_param == "new" {
        handle_new_remote_session(
            socket,
            state.clone(),
            client_id,
            mode,
            requested_since,
            client_epoch,
        )
        .await;
        state.control.unregister_client(client_id);
        return;
    }

    // No session specified → also create new
    if session_param.is_empty() {
        handle_new_remote_session(
            socket,
            state.clone(),
            client_id,
            mode,
            requested_since,
            client_epoch,
        )
        .await;
        state.control.unregister_client(client_id);
        return;
    }

    // Try to attach to existing app session
    let bridge_data = {
        if let Some(session) = state.app_session_manager.get(session_param) {
            let rx = session.broadcast.subscribe();
            let snapshot = session.get_scrollback_snapshot();
            let size = session.size().unwrap_or((80, 24));
            let epoch = session.session_epoch();
            Some((rx, snapshot, size, epoch))
        } else {
            None
        }
    };

    if let Some((rx, snapshot, size, epoch)) = bridge_data {
        let since = effective_since(requested_since, client_epoch, Some(epoch));
        handle_app_session_bridge(
            socket,
            state.clone(),
            session_param.to_string(),
            mode,
            since,
            rx,
            snapshot,
            size,
            Some(epoch),
        )
        .await;
    } else {
        // Session not found — send error instead of silently creating a new shell
        let (mut sink, _) = socket.split();
        let msg = format!(
            r#"{{"type":"error","msg":"Session '{}' not found"}}"#,
            session_param.replace('"', "")
        );
        let _ = sink.send(Message::Text(msg.into())).await;
        let _ = sink.close().await;
    }
    state.control.unregister_client(client_id);
}

fn connected_frame(
    session_id: &str,
    mode: WsMode,
    source: SnapshotSourceKind,
    cols: u16,
    rows: u16,
    session_epoch: Option<u64>,
    resume: &ResumePayload,
) -> String {
    let mut value = serde_json::json!({
        "type": "connected",
        "session_id": session_id,
        "mode": mode.as_str(),
        "accepts_resize": client_resize_applies(mode, source),
        "cols": cols,
        "rows": rows,
        "resync": resume.resync,
        "start": resume.start,
        "end": resume.end,
    });
    if let Some(epoch) = session_epoch {
        value["session_epoch"] = serde_json::json!(epoch);
    }
    value.to_string()
}

fn catchup_frame(reason: &str, skipped: Option<u64>, resume: &ResumePayload) -> String {
    let mut value = serde_json::json!({
        "type": "resync",
        "reason": reason,
        "resync": resume.resync,
        "start": resume.start,
        "end": resume.end,
    });
    if let Some(n) = skipped {
        value["skipped"] = serde_json::json!(n);
    }
    value.to_string()
}

fn frame_bytes(end: u64, data: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(8 + data.len());
    frame.extend_from_slice(&end.to_le_bytes());
    frame.extend_from_slice(data);
    frame
}

/// Send scrollback in 16KB chunks to avoid freezing mobile clients.
async fn send_output_chunked(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    data: &[u8],
    start: u64,
) -> bool {
    if data.is_empty() {
        return true;
    }
    let mut offset = start;
    for chunk in data.chunks(SCROLLBACK_CHUNK_SIZE) {
        let end = offset.saturating_add(chunk.len() as u64);
        if sink
            .send(Message::Binary(frame_bytes(end, chunk).into()))
            .await
            .is_err()
        {
            return false;
        }
        offset = end;
        tokio::task::yield_now().await;
    }
    true
}

struct OutputBatch {
    data: Vec<u8>,
    end: u64,
}

impl OutputBatch {
    fn new() -> Self {
        Self {
            data: Vec::new(),
            end: 0,
        }
    }

    fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    fn len(&self) -> usize {
        self.data.len()
    }

    fn push(&mut self, chunk: OutputChunk) -> Option<OutputChunk> {
        if self.data.is_empty() {
            self.end = chunk.end;
            self.data = chunk.data;
            return None;
        }
        if chunk.start != self.end {
            return Some(chunk);
        }
        self.data.extend_from_slice(&chunk.data);
        self.end = chunk.end;
        None
    }

    fn take_frame(&mut self) -> Option<Vec<u8>> {
        if self.data.is_empty() {
            return None;
        }
        let frame = frame_bytes(self.end, &self.data);
        self.data.clear();
        self.end = 0;
        Some(frame)
    }
}

async fn flush_batch(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    batch: &mut OutputBatch,
) -> bool {
    if let Some(frame) = batch.take_frame() {
        return sink.send(Message::Binary(frame.into())).await.is_ok();
    }
    true
}

enum SnapshotSource {
    App(String),
    Remote(String),
}

async fn send_catchup(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    state: &RemoteState,
    source: &SnapshotSource,
    reason: &str,
    skipped: Option<u64>,
    last_sent_end: u64,
) -> Option<u64> {
    let snapshot = match source {
        SnapshotSource::App(id) => state
            .app_session_manager
            .get(id)
            .map(|session| session.get_scrollback_snapshot()),
        SnapshotSource::Remote(id) => state
            .sessions
            .get(id)
            .map(|session| session.get_scrollback_snapshot()),
    };
    let Some(snapshot) = snapshot else {
        return None;
    };
    let resume = catchup_from_snapshot(
        &snapshot.data,
        snapshot.start_offset,
        snapshot.end_offset,
        last_sent_end,
    );
    let frame = catchup_frame(reason, skipped, &resume);
    if sink.send(Message::Text(frame.into())).await.is_err() {
        return None;
    }
    if !send_output_chunked(sink, &resume.data, resume.start).await {
        return None;
    }
    Some(resume.end)
}

#[allow(clippy::too_many_arguments)]
async fn handle_app_session_bridge(
    socket: WebSocket,
    state: Arc<RemoteState>,
    session_id: String,
    mode: WsMode,
    since: Option<u64>,
    rx: broadcast::Receiver<OutputChunk>,
    snapshot: ScrollbackSnapshot,
    size: (u16, u16),
    session_epoch: Option<u64>,
) {
    run_session_socket(
        socket,
        state,
        session_id,
        mode,
        since,
        rx,
        snapshot,
        size,
        session_epoch,
        SnapshotSourceKind::App,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn run_session_socket(
    socket: WebSocket,
    state: Arc<RemoteState>,
    session_id: String,
    mode: WsMode,
    since: Option<u64>,
    mut rx: broadcast::Receiver<OutputChunk>,
    snapshot: ScrollbackSnapshot,
    size: (u16, u16),
    session_epoch: Option<u64>,
    source_kind: SnapshotSourceKind,
) {
    let (mut sink, mut stream) = socket.split();
    let mut disconnect_rx = state.control.subscribe_disconnect();
    let resume = resume_from_snapshot(
        &snapshot.data,
        snapshot.start_offset,
        snapshot.end_offset,
        since,
    );
    let connected = connected_frame(
        &session_id,
        mode,
        source_kind,
        size.0,
        size.1,
        session_epoch,
        &resume,
    );
    if sink.send(Message::Text(connected.into())).await.is_err() {
        return;
    }
    if !send_output_chunked(&mut sink, &resume.data, resume.start).await {
        return;
    }

    let pause_notify = Arc::new(Notify::new());
    let paused = Arc::new(AtomicBool::new(false));
    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<String>();

    let pause_notify_send = pause_notify.clone();
    let paused_send = paused.clone();
    let state_send = state.clone();
    let source = match source_kind {
        SnapshotSourceKind::App => SnapshotSource::App(session_id.clone()),
        SnapshotSourceKind::Remote => SnapshotSource::Remote(session_id.clone()),
    };

    let mut send_task = tokio::spawn(async move {
        let mut last_sent_end = resume.end;
        let mut batch = OutputBatch::new();
        let mut dropped_while_paused = false;
        let mut lagged_skip: Option<u64> = None;
        let flush_interval = tokio::time::sleep(REMOTE_FLUSH_INTERVAL);
        tokio::pin!(flush_interval);
        let mut flush_armed = false;

        loop {
            if paused_send.load(Ordering::Relaxed) {
                tokio::select! {
                    result = rx.recv() => {
                        match result {
                            Ok(_) => {
                                dropped_while_paused = true;
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                lagged_skip = Some(n);
                                dropped_while_paused = true;
                            }
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                    _ = pause_notify_send.notified() => {}
                    Some(ctrl_msg) = ctrl_rx.recv() => {
                        if sink.send(Message::Text(ctrl_msg.into())).await.is_err() {
                            break;
                        }
                    }
                    _ = disconnect_rx.recv() => {
                        let _ = sink.send(Message::Text(r#"{"type":"token_rotated"}"#.into())).await;
                        let _ = sink.close().await;
                        break;
                    }
                }
                continue;
            }

            if dropped_while_paused || lagged_skip.is_some() {
                if !batch.is_empty() {
                    last_sent_end = batch.end;
                }
                if !flush_batch(&mut sink, &mut batch).await {
                    break;
                }
                flush_armed = false;
                let reason = if lagged_skip.is_some() {
                    "lagged"
                } else {
                    "paused_drop"
                };
                match send_catchup(
                    &mut sink,
                    &state_send,
                    &source,
                    reason,
                    lagged_skip,
                    last_sent_end,
                )
                .await
                {
                    Some(end) => last_sent_end = end,
                    None => break,
                }
                dropped_while_paused = false;
                lagged_skip = None;
                continue;
            }

            tokio::select! {
                result = rx.recv() => {
                    match result {
                        Ok(chunk) => {
                            let chunk = match trim_overlap(chunk, last_sent_end) {
                                TrimResult::Skip => continue,
                                TrimResult::NeedResync => {
                                    lagged_skip = Some(lagged_skip.unwrap_or(0));
                                    continue;
                                }
                                TrimResult::Send(chunk) => chunk,
                            };
                            let was_empty = batch.is_empty();
                            if let Some(carry) = batch.push(chunk) {
                                last_sent_end = batch.end;
                                if !flush_batch(&mut sink, &mut batch).await {
                                    break;
                                }
                                flush_armed = false;
                                match trim_overlap(carry, last_sent_end) {
                                    TrimResult::Send(carry) => {
                                        let _ = batch.push(carry);
                                        flush_interval.as_mut().reset(
                                            tokio::time::Instant::now() + REMOTE_FLUSH_INTERVAL,
                                        );
                                        flush_armed = true;
                                    }
                                    TrimResult::NeedResync => {
                                        lagged_skip = Some(lagged_skip.unwrap_or(0));
                                    }
                                    TrimResult::Skip => {}
                                }
                            } else if was_empty {
                                flush_interval.as_mut().reset(
                                    tokio::time::Instant::now() + REMOTE_FLUSH_INTERVAL,
                                );
                                flush_armed = true;
                            }
                            if batch.len() >= REMOTE_BATCH_MAX_BYTES {
                                last_sent_end = batch.end;
                                if !flush_batch(&mut sink, &mut batch).await {
                                    break;
                                }
                                flush_armed = false;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            lagged_skip = Some(n);
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = &mut flush_interval, if flush_armed => {
                    if !batch.is_empty() {
                        last_sent_end = batch.end;
                    }
                    if !flush_batch(&mut sink, &mut batch).await {
                        break;
                    }
                    flush_armed = false;
                }
                Some(ctrl_msg) = ctrl_rx.recv() => {
                    if !batch.is_empty() {
                        last_sent_end = batch.end;
                    }
                    if !flush_batch(&mut sink, &mut batch).await {
                        break;
                    }
                    flush_armed = false;
                    if sink.send(Message::Text(ctrl_msg.into())).await.is_err() {
                        break;
                    }
                }
                _ = disconnect_rx.recv() => {
                    let _ = sink.send(Message::Text(r#"{"type":"token_rotated"}"#.into())).await;
                    let _ = sink.close().await;
                    break;
                }
            }
        }
    });

    let session_id_clone = session_id.clone();
    let state_clone = state.clone();
    let pause_notify_recv = pause_notify.clone();
    let paused_recv = paused.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(msg_result) = stream.next().await {
            let msg = match msg_result {
                Ok(m) => m,
                Err(_) => break,
            };
            match msg {
                Message::Binary(data) => match source_kind {
                    SnapshotSourceKind::App => {
                        if let Some(session) =
                            state_clone.app_session_manager.get(&session_id_clone)
                        {
                            let _ = session.write(&data);
                        }
                    }
                    SnapshotSourceKind::Remote => {
                        if let Some(session) = state_clone.sessions.get(&session_id_clone) {
                            let _ = session.write_input(&data);
                        }
                    }
                },
                Message::Text(text) => {
                    handle_client_control(
                        &text,
                        &session_id_clone,
                        &state_clone,
                        mode,
                        source_kind,
                        &paused_recv,
                        &pause_notify_recv,
                        &ctrl_tx,
                    );
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => { recv_task.abort(); }
        _ = &mut recv_task => { send_task.abort(); }
    }
}

fn handle_client_control(
    text: &str,
    session_id: &str,
    state: &RemoteState,
    mode: WsMode,
    source_kind: SnapshotSourceKind,
    paused: &AtomicBool,
    pause_notify: &Notify,
    ctrl_tx: &mpsc::UnboundedSender<String>,
) {
    #[derive(Deserialize)]
    struct ControlMsg {
        r#type: String,
        cols: Option<u16>,
        rows: Option<u16>,
    }

    if let Ok(msg) = serde_json::from_str::<ControlMsg>(text) {
        match msg.r#type.as_str() {
            "resize" => {
                if !client_resize_applies(mode, source_kind) {
                    return;
                }
                if let (Some(cols), Some(rows)) = (msg.cols, msg.rows) {
                    match source_kind {
                        SnapshotSourceKind::App => {
                            if let Some(session) = state.app_session_manager.get(session_id) {
                                let _ = session.resize(cols, rows);
                            }
                        }
                        SnapshotSourceKind::Remote => {
                            if let Some(session) = state.sessions.get(session_id) {
                                let _ = session.resize(cols, rows);
                            }
                        }
                    }
                }
            }
            "ping" => {
                let _ = ctrl_tx.send(r#"{"type":"pong"}"#.to_string());
            }
            "pause" => {
                paused.store(true, Ordering::Relaxed);
            }
            "resume" => {
                paused.store(false, Ordering::Relaxed);
                pause_notify.notify_one();
            }
            _ => {}
        }
    }
}

async fn handle_new_remote_session(
    socket: WebSocket,
    state: Arc<RemoteState>,
    client_id: u64,
    mode: WsMode,
    requested_since: Option<u64>,
    client_epoch: Option<u64>,
) {
    let (cmd, args) = get_default_shell();

    let session_id = match state.sessions.get_or_create(&cmd, &args, 80, 24) {
        Ok(id) => id,
        Err(e) => {
            let (mut sink, _) = socket.split();
            let msg = format!(r#"{{"type":"error","msg":"{e}"}}"#);
            let _ = sink.send(Message::Text(msg.into())).await;
            return;
        }
    };

    state
        .control
        .update_client_session(client_id, Some(session_id.clone()));

    let (rx, snapshot, size, server_epoch) = match state.sessions.get(&session_id) {
        Some(session) => (
            session.broadcast.subscribe(),
            session.get_scrollback_snapshot(),
            session.size().unwrap_or((80, 24)),
            session.session_epoch(),
        ),
        None => return,
    };

    let (since, session_epoch) =
        remote_session_connect_args(requested_since, client_epoch, server_epoch);

    run_session_socket(
        socket,
        state,
        session_id,
        mode,
        since,
        rx,
        snapshot,
        size,
        session_epoch,
        SnapshotSourceKind::Remote,
    )
    .await;
}

/// Replicate get_default_shell() logic from commands/terminal.rs
fn get_default_shell() -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).exists() {
                let lower = shell.to_ascii_lowercase();
                let args = if lower.ends_with("bash.exe") {
                    vec!["-i".to_string()]
                } else {
                    vec![]
                };
                return (shell, args);
            }
        }
        let git_bash = r"C:\Program Files\Git\bin\bash.exe";
        if std::path::Path::new(git_bash).exists() {
            return (git_bash.to_string(), vec!["-i".to_string()]);
        }
        let pwsh = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        if std::path::Path::new(pwsh).exists() {
            return (pwsh.to_string(), vec![]);
        }
        (
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
            vec![],
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).exists() {
                return (shell, vec![]);
            }
        }
        ("/bin/bash".to_string(), vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(start: u64, end: u64, data: &[u8]) -> OutputChunk {
        OutputChunk {
            data: data.to_vec(),
            start,
            end,
        }
    }

    #[test]
    fn trim_overlap_full_cover_is_dropped() {
        assert_eq!(trim_overlap(chunk(10, 20, b"abcdefghij"), 20), TrimResult::Skip);
        assert_eq!(trim_overlap(chunk(10, 20, b"abcdefghij"), 25), TrimResult::Skip);
    }

    #[test]
    fn trim_overlap_partial_drops_prefix() {
        let TrimResult::Send(trimmed) = trim_overlap(chunk(10, 20, b"abcdefghij"), 15) else {
            panic!("expected partial send");
        };
        assert_eq!(trimmed.start, 15);
        assert_eq!(trimmed.end, 20);
        assert_eq!(trimmed.data, b"fghij");
    }

    #[test]
    fn trim_overlap_no_overlap_keeps_chunk() {
        let TrimResult::Send(kept) = trim_overlap(chunk(20, 25, b"klmno"), 20) else {
            panic!("expected adjacent send");
        };
        assert_eq!(kept.start, 20);
        assert_eq!(kept.end, 25);
        assert_eq!(kept.data, b"klmno");

        let TrimResult::Send(later) = trim_overlap(chunk(30, 33, b"xyz"), 20) else {
            panic!("expected gap send");
        };
        assert_eq!(later.start, 30);
        assert_eq!(later.data, b"xyz");
    }

    #[test]
    fn trim_overlap_reversed_range_requests_resync() {
        assert_eq!(
            trim_overlap(chunk(20, 10, b"nope"), 0),
            TrimResult::NeedResync
        );
    }

    #[test]
    fn trim_overlap_length_mismatch_requests_resync() {
        assert_eq!(
            trim_overlap(chunk(10, 20, b"short"), 10),
            TrimResult::NeedResync
        );
    }

    #[test]
    fn resume_in_range_sends_delta_without_resync() {
        let payload = resume_from_snapshot(b"abcdefghij", 100, 110, Some(106));
        assert_eq!(
            payload,
            ResumePayload {
                data: b"ghij".to_vec(),
                start: 106,
                end: 110,
                resync: false,
            }
        );
    }

    #[test]
    fn resume_at_end_sends_empty_delta() {
        let payload = resume_from_snapshot(b"abcdefghij", 100, 110, Some(110));
        assert_eq!(
            payload,
            ResumePayload {
                data: Vec::new(),
                start: 110,
                end: 110,
                resync: false,
            }
        );
    }

    #[test]
    fn resume_out_of_range_sends_full_resync() {
        let before = resume_from_snapshot(b"abcdefghij", 100, 110, Some(90));
        assert!(before.resync);
        assert_eq!(before.data, b"abcdefghij");
        assert_eq!((before.start, before.end), (100, 110));

        let after = resume_from_snapshot(b"abcdefghij", 100, 110, Some(200));
        assert!(after.resync);
        assert_eq!(after.data, b"abcdefghij");

        let missing = resume_from_snapshot(b"abcdefghij", 100, 110, None);
        assert!(missing.resync);
    }

    #[test]
    fn view_mode_does_not_apply_resize_on_app_sessions() {
        assert!(!client_resize_applies(WsMode::View, SnapshotSourceKind::App));
        assert!(client_resize_applies(WsMode::Control, SnapshotSourceKind::App));
        assert_eq!(WsMode::parse(None), WsMode::View);
        assert_eq!(WsMode::parse(Some("view")), WsMode::View);
        assert_eq!(WsMode::parse(Some("CONTROL")), WsMode::Control);
        assert_eq!(WsMode::parse(Some("wat")), WsMode::View);
    }

    #[test]
    fn remote_only_shell_accepts_resize_in_view_mode() {
        assert!(client_resize_applies(WsMode::View, SnapshotSourceKind::Remote));
        assert!(client_resize_applies(
            WsMode::Control,
            SnapshotSourceKind::Remote
        ));
    }

    #[test]
    fn catchup_in_window_is_delta_without_resync() {
        let payload = catchup_from_snapshot(b"abcdefghij", 100, 110, 106);
        assert_eq!(
            payload,
            ResumePayload {
                data: b"ghij".to_vec(),
                start: 106,
                end: 110,
                resync: false,
            }
        );
    }

    #[test]
    fn lagged_in_window_is_delta_without_resync() {
        let payload = catchup_from_snapshot(b"0123456789", 200, 210, 205);
        assert!(!payload.resync);
        assert_eq!(payload.data, b"56789");
        assert_eq!((payload.start, payload.end), (205, 210));
    }

    #[test]
    fn catchup_out_of_window_is_full_resync() {
        let before = catchup_from_snapshot(b"abcdefghij", 100, 110, 50);
        assert!(before.resync);
        assert_eq!(before.data, b"abcdefghij");
        assert_eq!((before.start, before.end), (100, 110));
    }

    #[test]
    fn resume_length_mismatch_fails_closed_to_full_resync() {
        let payload = resume_from_snapshot(b"short", 100, 110, Some(106));
        assert!(payload.resync);
        assert_eq!(payload.data, b"short");
    }

    #[test]
    fn epoch_mismatch_drops_since() {
        assert_eq!(effective_since(Some(50), Some(1), Some(2)), None);
        assert_eq!(effective_since(Some(50), None, Some(2)), None);
        assert_eq!(effective_since(Some(50), Some(2), Some(2)), Some(50));
        assert_eq!(effective_since(Some(50), None, None), Some(50));
        assert_eq!(effective_since(None, Some(2), Some(2)), None);
    }

    #[test]
    fn remote_shell_connect_uses_effective_since_and_carries_epoch() {
        let (since, epoch) = remote_session_connect_args(Some(50), Some(1), 2);
        assert_eq!(since, None);
        assert_eq!(epoch, Some(2));

        let (kept, epoch) = remote_session_connect_args(Some(50), Some(2), 2);
        assert_eq!(kept, Some(50));
        assert_eq!(epoch, Some(2));

        let (none_since, epoch) = remote_session_connect_args(None, Some(2), 2);
        assert_eq!(none_since, None);
        assert_eq!(epoch, Some(2));

        let frame = connected_frame(
            "default",
            WsMode::View,
            SnapshotSourceKind::Remote,
            80,
            24,
            epoch,
            &ResumePayload {
                data: Vec::new(),
                start: 0,
                end: 0,
                resync: true,
            },
        );
        let value: serde_json::Value = serde_json::from_str(&frame).expect("connected json");
        assert_eq!(value["session_epoch"], 2);
        assert_eq!(value["accepts_resize"], true);
        assert_eq!(value["type"], "connected");
    }
}
