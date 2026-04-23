use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Notify};

use super::RemoteState;

/// Scrollback chunk size (16 KB) to avoid freezing mobile clients.
const SCROLLBACK_CHUNK_SIZE: usize = 16 * 1024;

#[derive(Deserialize)]
pub struct WsQuery {
    token: String,
    session: Option<String>,
}

/// HTTP handler — upgrades to WebSocket after token validation.
pub async fn ws_upgrade(
    State(state): State<Arc<RemoteState>>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !super::auth::validate_token(&query.token, &state.token) {
        return (axum::http::StatusCode::UNAUTHORIZED, "Invalid token").into_response();
    }
    ws.on_upgrade(move |socket| handle_ws(socket, state, query))
        .into_response()
}

async fn handle_ws(socket: WebSocket, state: Arc<RemoteState>, query: WsQuery) {
    let session_param = query.session.as_deref().unwrap_or("");

    // Explicit "new" → create a fresh remote shell
    if session_param == "new" {
        handle_new_remote_session(socket, state).await;
        return;
    }

    // No session specified → also create new
    if session_param.is_empty() {
        handle_new_remote_session(socket, state).await;
        return;
    }

    // Try to attach to existing app session
    let bridge_data = {
        if let Some(session) = state.app_session_manager.get(session_param) {
            let rx = session.broadcast.subscribe();
            let sb = session.get_scrollback();
            Some((rx, sb))
        } else {
            None
        }
    };

    if let Some((rx, sb)) = bridge_data {
        handle_app_session_bridge(socket, state, session_param.to_string(), rx, sb).await;
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
}


/// Send scrollback in 16KB chunks to avoid freezing mobile clients.
async fn send_scrollback_chunked(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    scrollback: &[u8],
) -> bool {
    if scrollback.is_empty() {
        return true;
    }
    for chunk in scrollback.chunks(SCROLLBACK_CHUNK_SIZE) {
        if sink
            .send(Message::Binary(chunk.to_vec().into()))
            .await
            .is_err()
        {
            return false;
        }
        tokio::task::yield_now().await;
    }
    true
}

async fn handle_app_session_bridge(
    socket: WebSocket,
    state: Arc<RemoteState>,
    session_id: String,
    mut rx: broadcast::Receiver<Vec<u8>>,
    scrollback: Vec<u8>,
) {
    let (mut sink, mut stream) = socket.split();

    let connected = format!(r#"{{"type":"connected","session_id":"{session_id}","mode":"attach"}}"#);
    if sink.send(Message::Text(connected.into())).await.is_err() {
        return;
    }

    // Send scrollback in chunks
    if !send_scrollback_chunked(&mut sink, &scrollback).await {
        return;
    }

    // Flow control: shared pause state
    let pause_notify = Arc::new(Notify::new());
    let paused = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Channel for control responses (pong) from recv_task to send_task
    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<String>();

    let pause_notify_send = pause_notify.clone();
    let paused_send = paused.clone();

    let mut send_task = tokio::spawn(async move {
        loop {
            // If paused by flow control, wait until client resumes
            if paused_send.load(std::sync::atomic::Ordering::Relaxed) {
                pause_notify_send.notified().await;
                continue;
            }
            tokio::select! {
                result = rx.recv() => {
                    match result {
                        Ok(data) => {
                            if sink.send(Message::Binary(data.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("[remote] WebSocket lagged on app session, skipped {n} messages");
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                Some(ctrl_msg) = ctrl_rx.recv() => {
                    if sink.send(Message::Text(ctrl_msg.into())).await.is_err() {
                        break;
                    }
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
                Message::Binary(data) => {
                    if let Some(session) = state_clone.app_session_manager.get(&session_id_clone) {
                        let _ = session.write(&data);
                    }
                }
                Message::Text(text) => {
                    handle_app_control(
                        &text,
                        &session_id_clone,
                        &state_clone,
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

fn handle_app_control(
    text: &str,
    session_id: &str,
    state: &RemoteState,
    paused: &std::sync::atomic::AtomicBool,
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
                if let (Some(cols), Some(rows)) = (msg.cols, msg.rows) {
                    if let Some(session) = state.app_session_manager.get(session_id) {
                        let _ = session.resize(cols, rows);
                    }
                }
            }
            "ping" => {
                let _ = ctrl_tx.send(r#"{"type":"pong"}"#.to_string());
            }
            "pause" => {
                paused.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            "resume" => {
                paused.store(false, std::sync::atomic::Ordering::Relaxed);
                pause_notify.notify_one();
            }
            _ => {}
        }
    }
}

async fn handle_new_remote_session(socket: WebSocket, state: Arc<RemoteState>) {
    let (mut sink, mut stream) = socket.split();

    let (cmd, args) = get_default_shell();

    let session_id = match state.sessions.get_or_create(&cmd, &args, 80, 24) {
        Ok(id) => id,
        Err(e) => {
            let msg = format!(r#"{{"type":"error","msg":"{e}"}}"#);
            let _ = sink.send(Message::Text(msg.into())).await;
            return;
        }
    };

    let connected = format!(r#"{{"type":"connected","session_id":"{session_id}"}}"#);
    if sink.send(Message::Text(connected.into())).await.is_err() {
        return;
    }

    // Send scrollback in chunks
    if let Some(session) = state.sessions.get(&session_id) {
        let sb = session.get_scrollback();
        if !send_scrollback_chunked(&mut sink, &sb).await {
            return;
        }
    }

    let rx = state
        .sessions
        .get(&session_id)
        .map(|s| s.broadcast.subscribe());

    let Some(mut rx) = rx else { return };

    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(data) => {
                    if sink.send(Message::Binary(data.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[remote] WebSocket lagged, skipped {n} messages");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let session_id_clone = session_id.clone();
    let state_clone = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(msg_result) = stream.next().await {
            let msg = match msg_result {
                Ok(m) => m,
                Err(_) => break,
            };
            match msg {
                Message::Binary(data) => {
                    if let Some(session) = state_clone.sessions.get(&session_id_clone) {
                        let _ = session.write_input(&data);
                    }
                }
                Message::Text(text) => {
                    handle_control(&text, &session_id_clone, &state_clone);
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

fn handle_control(text: &str, session_id: &str, state: &RemoteState) {
    #[derive(Deserialize)]
    struct ControlMsg {
        r#type: String,
        cols: Option<u16>,
        rows: Option<u16>,
    }

    if let Ok(msg) = serde_json::from_str::<ControlMsg>(text) {
        match msg.r#type.as_str() {
            "resize" => {
                if let (Some(cols), Some(rows)) = (msg.cols, msg.rows) {
                    if let Some(session) = state.sessions.get(session_id) {
                        let _ = session.resize(cols, rows);
                    }
                }
            }
            "ping" => {
                // Client keepalive — no action needed
            }
            _ => {}
        }
    }
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
