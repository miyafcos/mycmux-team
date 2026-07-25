use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// How long to wait for the frontend to answer a bridged socket request
/// before treating it as unresponsive. Without this bound, a frontend that
/// never calls `socket_response` (e.g. reloaded mid-request) leaks both the
/// spawned tokio task and its `pending_requests` entry forever.
const FRONTEND_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

pub struct SocketState {
    pub pending_requests: Arc<DashMap<usize, oneshot::Sender<SocketResponse>>>,
    pub next_id: AtomicUsize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketRequest {
    pub id: usize,
    pub cmd: String,
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketResponse {
    pub id: usize,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn socket_response(
    state: tauri::State<'_, SocketState>,
    id: usize,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if let Some((_, sender)) = state.pending_requests.remove(&id) {
        let _ = sender.send(SocketResponse { id, result, error });
    }
    Ok(())
}

async fn await_frontend_response(
    pending_requests: &DashMap<usize, oneshot::Sender<SocketResponse>>,
    id: usize,
    rx: oneshot::Receiver<SocketResponse>,
    timeout: Duration,
) -> SocketResponse {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(_)) => {
            // Sender dropped without a response.
            pending_requests.remove(&id);
            SocketResponse {
                id,
                result: None,
                error: Some("Frontend dropped the request".to_string()),
            }
        }
        Err(_) => {
            // Timed out waiting for the frontend.
            pending_requests.remove(&id);
            SocketResponse {
                id,
                result: None,
                error: Some("Frontend response timed out".to_string()),
            }
        }
    }
}

async fn handle_connection(stream: TcpStream, app: AppHandle) {
    let state = app.state::<SocketState>();
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // Connection closed
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if let Ok(mut parsed) = serde_json::from_str::<Value>(trimmed) {
                    if let Some(obj) = parsed.as_object_mut() {
                        let cmd = obj
                            .get("cmd")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let args = obj.remove("args").unwrap_or(Value::Null);

                        let id = state.next_id.fetch_add(1, Ordering::SeqCst);
                        let (tx, rx) = oneshot::channel();

                        state.pending_requests.insert(id, tx);

                        let req = SocketRequest { id, cmd, args };
                        if app.emit("socket-request", &req).is_ok() {
                            // Wait for frontend response, bounded so an
                            // unresponsive frontend cannot leak this task or
                            // its pending_requests entry forever.
                            let resp = await_frontend_response(
                                state.pending_requests.as_ref(),
                                id,
                                rx,
                                FRONTEND_RESPONSE_TIMEOUT,
                            )
                            .await;
                            let resp_json = serde_json::to_string(&resp).unwrap_or_default();
                            let _ = writer.write_all(resp_json.as_bytes()).await;
                            let _ = writer.write_all(b"\n").await;
                            let _ = writer.flush().await;
                        } else {
                            state.pending_requests.remove(&id);
                            let err_resp = SocketResponse {
                                id,
                                result: None,
                                error: Some("Frontend not ready".to_string()),
                            };
                            let resp_json = serde_json::to_string(&err_resp).unwrap_or_default();
                            let _ = writer.write_all(resp_json.as_bytes()).await;
                            let _ = writer.write_all(b"\n").await;
                            let _ = writer.flush().await;
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }
}

/// Get the path to the port file for socket discovery
fn get_port_file_path() -> std::path::PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    path.push(".mycmux");
    std::fs::create_dir_all(&path).ok();
    path.push("mycmux.port");
    path
}

/// Clean up old Unix socket file if it exists (for migration from old versions)
fn cleanup_legacy_socket() {
    let mut socket_path = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    socket_path.push(".ptrterminal");
    socket_path.push("ptr.sock");
    let _ = std::fs::remove_file(&socket_path);
}

pub fn start_socket_listener(app: AppHandle) {
    // Clean up legacy Unix socket if migrating
    cleanup_legacy_socket();

    let port_file = get_port_file_path();

    tauri::async_runtime::spawn(async move {
        // Bind to localhost with port 0 to get a random available port
        match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => {
                let addr = listener.local_addr().expect("Failed to get local address");
                let port = addr.port();

                // Write port to file for CLI tools to discover
                if let Err(e) = std::fs::write(&port_file, port.to_string()) {
                    eprintln!("Failed to write port file: {}", e);
                    return;
                }

                #[cfg(debug_assertions)]
                {
                    println!("Socket listening on 127.0.0.1:{}", port);
                    println!("Port file: {:?}", port_file);
                }

                loop {
                    if let Ok((stream, peer_addr)) = listener.accept().await {
                        // Only accept connections from localhost for security
                        if !peer_addr.ip().is_loopback() {
                            eprintln!("Rejected non-localhost connection from {}", peer_addr);
                            continue;
                        }

                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            handle_connection(stream, app_clone).await;
                        });
                    }
                }
            }
            Err(e) => {
                eprintln!("Failed to bind TCP socket: {}", e);
            }
        }
    });
}

/// Read the port from the port file (for use by CLI tools)
#[allow(dead_code)]
pub fn read_socket_port() -> Option<u16> {
    let port_file = get_port_file_path();
    std::fs::read_to_string(&port_file)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frontend_response_is_forwarded_without_timeout() {
        let pending_requests = DashMap::new();
        let (tx, rx) = oneshot::channel();
        pending_requests.insert(7, tx);
        let (_, sender) = pending_requests
            .remove(&7)
            .expect("pending response sender should exist");
        sender
            .send(SocketResponse {
                id: 7,
                result: Some(serde_json::json!({ "ok": true })),
                error: None,
            })
            .expect("response receiver should remain open");

        let response = await_frontend_response(
            &pending_requests,
            7,
            rx,
            Duration::from_secs(1),
        )
        .await;

        assert_eq!(response.id, 7);
        assert_eq!(response.result, Some(serde_json::json!({ "ok": true })));
        assert_eq!(response.error, None);
        assert!(pending_requests.is_empty());
    }

    #[tokio::test]
    async fn dropped_frontend_sender_returns_error_and_cleans_pending_request() {
        let pending_requests = DashMap::new();
        let (tx, rx) = oneshot::channel();
        pending_requests.insert(8, tx);
        let (_, sender) = pending_requests
            .remove(&8)
            .expect("pending response sender should exist");
        drop(sender);

        let response = await_frontend_response(
            &pending_requests,
            8,
            rx,
            Duration::from_secs(1),
        )
        .await;

        assert_eq!(response.id, 8);
        assert_eq!(response.result, None);
        assert_eq!(response.error.as_deref(), Some("Frontend dropped the request"));
        assert!(pending_requests.is_empty());
    }

    #[tokio::test]
    async fn frontend_timeout_removes_pending_request() {
        let pending_requests = DashMap::new();
        let (tx, rx) = oneshot::channel();
        pending_requests.insert(9, tx);

        let response =
            await_frontend_response(&pending_requests, 9, rx, Duration::ZERO).await;

        assert_eq!(response.id, 9);
        assert_eq!(response.result, None);
        assert_eq!(response.error.as_deref(), Some("Frontend response timed out"));
        assert!(pending_requests.is_empty());
    }
}
