use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// How long to wait for the frontend to answer a bridged socket request
/// before treating it as unresponsive. Without this bound, a frontend that
/// never calls `socket_response` (e.g. reloaded mid-request) leaks both the
/// spawned tokio task and its `pending_requests` entry forever.
const FRONTEND_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const STATUS_RECONCILE_INTERVAL: Duration = Duration::from_secs(90);

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

fn state_view_session_id(args: &Value) -> Result<Option<String>, String> {
    if args.is_null() {
        return Ok(None);
    }
    let object = args
        .as_object()
        .ok_or_else(|| "session.state_view args must be an object".to_string())?;
    let value = object.get("session_id").or_else(|| object.get("sessionId"));
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(session_id)) if !session_id.trim().is_empty() => {
            Ok(Some(session_id.clone()))
        }
        Some(Value::String(_)) => Err("session.state_view session_id cannot be empty".to_string()),
        Some(_) => Err("session.state_view session_id must be a string".to_string()),
    }
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

async fn write_json_line<W, T>(writer: &mut W, value: &T) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let json = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    writer.write_all(&json).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}

async fn serve_status_connection(
    reader: BufReader<OwnedReadHalf>,
    mut writer: OwnedWriteHalf,
    feed: crate::status_feed::StatusFeed,
    subscribe_request: crate::status_feed::FeedRequest,
) {
    let (subscription, initial_snapshot) = feed.subscribe();
    let response = crate::status_feed::FeedResponseFrame::success(
        subscribe_request.id,
        serde_json::json!({ "subscribed": true }),
    );
    if write_json_line(&mut writer, &response).await.is_err()
        || write_json_line(&mut writer, &initial_snapshot)
            .await
            .is_err()
    {
        return;
    }

    let mut lines = reader.lines();
    let first_reconcile = tokio::time::Instant::now() + STATUS_RECONCILE_INTERVAL;
    let mut reconcile = tokio::time::interval_at(first_reconcile, STATUS_RECONCILE_INTERVAL);

    loop {
        tokio::select! {
            event = subscription.recv() => {
                let Some(event) = event else { return };
                if write_json_line(&mut writer, &event).await.is_err() {
                    return;
                }
            }
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { return };
                if line.trim().is_empty() {
                    continue;
                }
                let request = serde_json::from_str::<crate::status_feed::FeedRequest>(&line);
                let response = match request {
                    Ok(request) => match request.validate("status.snapshot") {
                        Ok(()) => {
                            let snapshot = feed.resnapshot(&subscription);
                            crate::status_feed::FeedResponseFrame::success(
                                request.id,
                                serde_json::to_value(snapshot).unwrap_or(Value::Null),
                            )
                        }
                        Err(error) => crate::status_feed::FeedResponseFrame::error(request.id, error),
                    },
                    Err(error) => crate::status_feed::FeedResponseFrame::error(
                        0,
                        format!("invalid status feed request: {error}"),
                    ),
                };
                if write_json_line(&mut writer, &response).await.is_err() {
                    return;
                }
            }
            _ = reconcile.tick() => {
                let snapshot = feed.periodic_snapshot(&subscription);
                if write_json_line(&mut writer, &snapshot).await.is_err() {
                    return;
                }
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
                    if parsed.get("cmd").and_then(Value::as_str) == Some("status.subscribe") {
                        let request_id = parsed.get("id").and_then(Value::as_u64).unwrap_or(0);
                        let request = serde_json::from_value::<crate::status_feed::FeedRequest>(
                            parsed.clone(),
                        );
                        match request {
                            Ok(request) => {
                                if let Err(error) = request.validate("status.subscribe") {
                                    let response = crate::status_feed::FeedResponseFrame::error(
                                        request.id, error,
                                    );
                                    let _ = write_json_line(&mut writer, &response).await;
                                    return;
                                }
                                let feed = app.state::<crate::AppState>().status_feed.clone();
                                serve_status_connection(reader, writer, feed, request).await;
                            }
                            Err(error) => {
                                let response = crate::status_feed::FeedResponseFrame::error(
                                    request_id,
                                    format!("invalid status.subscribe request: {error}"),
                                );
                                let _ = write_json_line(&mut writer, &response).await;
                            }
                        }
                        return;
                    }
                    if let Some(obj) = parsed.as_object_mut() {
                        let cmd = obj
                            .get("cmd")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let args = obj.remove("args").unwrap_or(Value::Null);

                        let id = state.next_id.fetch_add(1, Ordering::SeqCst);
                        if cmd == "session.state_view" {
                            let response = match state_view_session_id(&args) {
                                Ok(session_id) => {
                                    let snapshot = app
                                        .state::<crate::AppState>()
                                        .session_state_store
                                        .snapshot(session_id.as_deref());
                                    SocketResponse {
                                        id,
                                        result: serde_json::to_value(snapshot).ok(),
                                        error: None,
                                    }
                                }
                                Err(error) => SocketResponse {
                                    id,
                                    result: None,
                                    error: Some(error),
                                },
                            };
                            let response_json =
                                serde_json::to_string(&response).unwrap_or_default();
                            let _ = writer.write_all(response_json.as_bytes()).await;
                            let _ = writer.write_all(b"\n").await;
                            let _ = writer.flush().await;
                            continue;
                        }
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
    use crate::session_state::{Evidence, MonitorStatus, SessionStateStore};

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

        let response =
            await_frontend_response(&pending_requests, 7, rx, Duration::from_secs(1)).await;

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

        let response =
            await_frontend_response(&pending_requests, 8, rx, Duration::from_secs(1)).await;

        assert_eq!(response.id, 8);
        assert_eq!(response.result, None);
        assert_eq!(
            response.error.as_deref(),
            Some("Frontend dropped the request")
        );
        assert!(pending_requests.is_empty());
    }

    #[tokio::test]
    async fn frontend_timeout_removes_pending_request() {
        let pending_requests = DashMap::new();
        let (tx, rx) = oneshot::channel();
        pending_requests.insert(9, tx);

        let response = await_frontend_response(&pending_requests, 9, rx, Duration::ZERO).await;

        assert_eq!(response.id, 9);
        assert_eq!(response.result, None);
        assert_eq!(
            response.error.as_deref(),
            Some("Frontend response timed out")
        );
        assert!(pending_requests.is_empty());
    }

    #[test]
    fn state_view_accepts_optional_snake_or_camel_case_session_id() {
        assert_eq!(state_view_session_id(&Value::Null).unwrap(), None);
        assert_eq!(
            state_view_session_id(&serde_json::json!({ "session_id": "session-a" })).unwrap(),
            Some("session-a".to_string())
        );
        assert_eq!(
            state_view_session_id(&serde_json::json!({ "sessionId": "session-b" })).unwrap(),
            Some("session-b".to_string())
        );
        assert!(state_view_session_id(&serde_json::json!({ "session_id": 3 })).is_err());
    }

    #[tokio::test]
    async fn status_connection_orders_snapshot_before_delta_and_cleans_up_on_eof() {
        let store = SessionStateStore::new();
        store.ingest(
            "session-a",
            Evidence::monitor_status(1, 1, MonitorStatus::Idle, None),
        );
        let feed = crate::status_feed::StatusFeed::new(store.clone());
        store.set_change_listener(feed.change_listener());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_feed = feed.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, writer) = stream.into_split();
            serve_status_connection(
                BufReader::new(reader),
                writer,
                server_feed,
                crate::status_feed::FeedRequest {
                    v: 2,
                    id: 41,
                    cmd: "status.subscribe".to_string(),
                    args: serde_json::json!({}),
                },
            )
            .await;
        });

        let client = TcpStream::connect(address).await.unwrap();
        let (reader, writer) = client.into_split();
        let mut lines = BufReader::new(reader).lines();
        let response: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        let snapshot: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(response["kind"], "response");
        assert_eq!(response["id"], 41);
        assert_eq!(snapshot["event"], "status.snapshot");
        assert_eq!(snapshot["seq"], 0);

        store.ingest(
            "session-a",
            Evidence::monitor_status(2, 1, MonitorStatus::Working, None),
        );
        let delta: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(delta["event"], "status.changed");
        assert_eq!(delta["seq"], 1);
        assert_eq!(delta["session_revision"], 2);

        drop(lines);
        drop(writer);
        server.await.unwrap();
        assert_eq!(feed.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn status_connection_allows_only_snapshot_requests_after_subscribe() {
        let store = SessionStateStore::new();
        let feed = crate::status_feed::StatusFeed::new(store.clone());
        store.set_change_listener(feed.change_listener());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, writer) = stream.into_split();
            serve_status_connection(
                BufReader::new(reader),
                writer,
                feed,
                crate::status_feed::FeedRequest {
                    v: 2,
                    id: 1,
                    cmd: "status.subscribe".to_string(),
                    args: serde_json::json!({}),
                },
            )
            .await;
        });

        let stream = TcpStream::connect(address).await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut lines = BufReader::new(reader).lines();
        let _ = lines.next_line().await.unwrap().unwrap();
        let _ = lines.next_line().await.unwrap().unwrap();

        writer
            .write_all(b"{\"v\":2,\"id\":2,\"cmd\":\"workspace.list\",\"args\":{}}\n")
            .await
            .unwrap();
        let error: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(error["kind"], "response");
        assert!(error["error"]
            .as_str()
            .unwrap()
            .contains("unsupported command"));

        writer
            .write_all(b"{\"v\":2,\"id\":3,\"cmd\":\"status.snapshot\",\"args\":{}}\n")
            .await
            .unwrap();
        let snapshot: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(snapshot["kind"], "response");
        assert_eq!(snapshot["id"], 3);
        assert!(snapshot["result"]["server_epoch"].is_string());
        assert!(snapshot["result"]["sessions"].is_array());

        drop(lines);
        drop(writer);
        server.await.unwrap();
    }
}
