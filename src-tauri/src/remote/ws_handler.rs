use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::broadcast;

use super::RemoteState;

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
    let attach_session = query.session.as_deref().filter(|s| *s != "new");

    if let Some(session_id) = attach_session {
        let bridge_data = {
            if let Some(session) = state.app_session_manager.get(session_id) {
                let rx = session.broadcast.subscribe();
                let sb = session.get_scrollback();
                Some((rx, sb))
            } else {
                None
            }
        };
        if let Some((rx, sb)) = bridge_data {
            let sid = session_id.to_string();
            handle_app_session_bridge(socket, state, sid, rx, sb).await;
            return;
        }
    }

    handle_new_remote_session(socket, state).await;
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

    if !scrollback.is_empty() {
        let _ = sink.send(Message::Binary(scrollback.into())).await;
    }

    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
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
                    if let Some(session) = state_clone.app_session_manager.get(&session_id_clone) {
                        let _ = session.write(&data);
                    }
                }
                Message::Text(text) => {
                    handle_app_control(&text, &session_id_clone, &state_clone);
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

fn handle_app_control(text: &str, session_id: &str, state: &RemoteState) {
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
            "ping" => {}
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

    if let Some(session) = state.sessions.get(&session_id) {
        let sb = session.get_scrollback();
        if !sb.is_empty() {
            let _ = sink.send(Message::Binary(sb.into())).await;
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
    if let Ok(shell) = std::env::var("SHELL") {
        if std::path::Path::new(&shell).exists() {
            return (shell, vec![]);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let git_bash = r"C:\Program Files\Git\bin\bash.exe";
        if std::path::Path::new(git_bash).exists() {
            return (git_bash.to_string(), vec!["--login".to_string()]);
        }
        let pwsh = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        if std::path::Path::new(pwsh).exists() {
            return (pwsh.to_string(), vec![]);
        }
        return (
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
            vec![],
        );
    }

    #[cfg(not(target_os = "windows"))]
    {
        ("/bin/bash".to_string(), vec![])
    }
}
