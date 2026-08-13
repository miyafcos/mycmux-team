use dashmap::DashMap;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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

/// Every process on the machine can reach 127.0.0.1, so the loopback peer check
/// is not an authorization boundary — it only keeps the LAN out. Callers must
/// additionally prove they can read this process's token file, which lives next
/// to the port file. Same posture as the remote server (`remote/auth.rs`), but a
/// separate secret with a separate lifetime: it is regenerated on every start.
const SOCKET_TOKEN_FILE: &str = "mycmux.token";
/// Escape hatch for external consumers that have not been migrated yet.
const SOCKET_AUTH_ENV: &str = "MYCMUX_SOCKET_AUTH";
/// Rejected callers usually retry in a loop and diag.log rotates at 1 MiB, so
/// report at most one rejection per window and fold the rest into a count.
const REJECTION_LOG_INTERVAL_MS: u64 = 60_000;

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

/// Keeps a retrying unauthorized caller from filling diag.log.
#[derive(Debug)]
struct RejectionLogThrottle {
    logged_once: AtomicBool,
    last_logged_ms: AtomicU64,
    suppressed: AtomicU64,
}

impl RejectionLogThrottle {
    fn new() -> Self {
        Self {
            logged_once: AtomicBool::new(false),
            last_logged_ms: AtomicU64::new(0),
            suppressed: AtomicU64::new(0),
        }
    }

    /// `Some(suppressed_since_the_last_report)` when this rejection should be
    /// logged, `None` when it falls inside the current quiet window.
    ///
    // ponytail: lock-free read-modify-write, so a burst can emit two lines for
    // one window; a mutex here would serialize the reject path for no
    // diagnostic gain. Swap in a Mutex only if the count must be exact.
    fn take_report(&self, now_ms: u64, interval_ms: u64) -> Option<u64> {
        let due = !self.logged_once.load(Ordering::Acquire)
            || now_ms.saturating_sub(self.last_logged_ms.load(Ordering::Acquire)) >= interval_ms;
        if !due {
            self.suppressed.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        self.logged_once.store(true, Ordering::Release);
        self.last_logged_ms.store(now_ms, Ordering::Release);
        Some(self.suppressed.swap(0, Ordering::Relaxed))
    }
}

/// Access control for the local automation socket.
#[derive(Debug)]
pub struct SocketAuth {
    /// `None` means enforcement is switched off (`MYCMUX_SOCKET_AUTH=off`).
    expected_token: Option<String>,
    rejection_log: RejectionLogThrottle,
}

impl SocketAuth {
    fn enforcing(token: String) -> Self {
        Self {
            expected_token: Some(token),
            rejection_log: RejectionLogThrottle::new(),
        }
    }

    fn disabled() -> Self {
        Self {
            expected_token: None,
            rejection_log: RejectionLogThrottle::new(),
        }
    }

    fn authorize(&self, provided: Option<&str>) -> bool {
        let Some(expected) = self.expected_token.as_deref() else {
            return true;
        };
        provided.is_some_and(|provided| crate::remote::auth::validate_token(provided, expected))
    }

    /// Log a rejection with enough detail to find the caller.
    ///
    /// The peer address alone identifies nothing: these clients connect once
    /// per request, so the ephemeral port differs every time. Tracking a run of
    /// 411 rejections back to its source took a process sweep and a full-text
    /// search of the machine. The command name says what the caller wanted, and
    /// `had_token` separates "never sent one" (a client that predates socket
    /// auth) from "sent a stale one" (a long-lived client holding a token from
    /// before the last mycmux restart, since the token is regenerated on every
    /// start). The token value itself is never logged.
    fn note_rejection(&self, peer: SocketAddr, command: Option<&str>, had_token: bool) {
        let Some(suppressed) = self
            .rejection_log
            .take_report(now_millis(), REJECTION_LOG_INTERVAL_MS)
        else {
            return;
        };
        let reason = if had_token { "stale token" } else { "no token" };
        let command = command.unwrap_or("<unknown>");
        if suppressed == 0 {
            crate::diag_warn!(
                "socket",
                "Rejected request from {} (cmd={}, {})",
                peer,
                command,
                reason
            );
        } else {
            crate::diag_warn!(
                "socket",
                "Rejected request from {} (cmd={}, {}) ({} more suppressed in the last {}s)",
                peer,
                command,
                reason,
                suppressed,
                REJECTION_LOG_INTERVAL_MS / 1000
            );
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Remove the credential from the request so it never reaches the frontend
/// bridge, the emitted `socket-request` payload, or any log line.
fn take_request_token(parsed: &mut Value) -> Option<String> {
    match parsed.as_object_mut()?.remove("token")? {
        Value::String(token) => Some(token),
        _ => None,
    }
}

/// A struct (not `json!`) so the field order on the wire is the documented one:
/// `serde_json::Map` sorts keys alphabetically unless `preserve_order` is on.
#[derive(Debug, Serialize)]
struct UnauthorizedResponse {
    ok: bool,
    error: &'static str,
}

fn unauthorized_response() -> UnauthorizedResponse {
    UnauthorizedResponse {
        ok: false,
        error: "unauthorized",
    }
}

/// Only the documented `off` value disables enforcement; anything else (empty,
/// typo, `false`) keeps the socket authenticated.
fn auth_disabled_by_setting(raw: Option<&str>) -> bool {
    raw.is_some_and(|value| value.trim().eq_ignore_ascii_case("off"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SendTextExpectations {
    session_id: String,
    session_epoch: Option<u64>,
    attention_id: Option<String>,
    session_revision: Option<u64>,
}

fn aliased_value<'a>(
    object: &'a serde_json::Map<String, Value>,
    snake_case: &str,
    camel_case: &str,
) -> Result<Option<&'a Value>, String> {
    match (object.get(snake_case), object.get(camel_case)) {
        (Some(snake), Some(camel)) if snake != camel => Err(format!(
            "pane.send_text {snake_case} and {camel_case} must match"
        )),
        (Some(value), _) | (_, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

fn optional_u64_arg(
    object: &serde_json::Map<String, Value>,
    snake_case: &str,
    camel_case: &str,
) -> Result<Option<u64>, String> {
    aliased_value(object, snake_case, camel_case)?
        .map(|value| {
            value.as_u64().ok_or_else(|| {
                format!("pane.send_text {snake_case} must be a non-negative integer")
            })
        })
        .transpose()
}

fn optional_string_arg(
    object: &serde_json::Map<String, Value>,
    snake_case: &str,
    camel_case: &str,
) -> Result<Option<String>, String> {
    aliased_value(object, snake_case, camel_case)?
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("pane.send_text {snake_case} must be a string"))
        })
        .transpose()
}

fn send_text_expectations(
    command: &str,
    args: &Value,
) -> Result<Option<SendTextExpectations>, String> {
    if command != "pane.send_text" {
        return Ok(None);
    }
    let Some(object) = args.as_object() else {
        // Keep malformed legacy requests on the existing frontend validation path.
        return Ok(None);
    };
    let expectation_keys = [
        "expected_session_epoch",
        "expectedSessionEpoch",
        "expected_attention_id",
        "expectedAttentionId",
        "expected_session_revision",
        "expectedSessionRevision",
    ];
    if !expectation_keys.iter().any(|key| object.contains_key(*key)) {
        return Ok(None);
    }

    let session_id = optional_string_arg(object, "session_id", "sessionId")?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "pane.send_text requires sessionId when expectations are provided".to_string()
        })?;
    Ok(Some(SendTextExpectations {
        session_id,
        session_epoch: optional_u64_arg(object, "expected_session_epoch", "expectedSessionEpoch")?,
        attention_id: optional_string_arg(object, "expected_attention_id", "expectedAttentionId")?,
        session_revision: optional_u64_arg(
            object,
            "expected_session_revision",
            "expectedSessionRevision",
        )?,
    }))
}

fn stale_send_text_result(
    store: &crate::session_state::SessionStateStore,
    expectations: &SendTextExpectations,
) -> Option<Value> {
    let Some(current_view) = store.current_view(&expectations.session_id) else {
        return Some(serde_json::json!({
            "sent": false,
            "reason": "unknown_session",
            "current": Value::Null,
        }));
    };

    let reason = if expectations
        .session_epoch
        .is_some_and(|expected| current_view.session_epoch != Some(expected))
    {
        Some("session_epoch")
    } else if expectations
        .attention_id
        .as_ref()
        .is_some_and(|expected| current_view.attention.attention_id.as_ref() != Some(expected))
    {
        Some("attention_id")
    } else if expectations
        .session_revision
        .is_some_and(|expected| expected > current_view.session_revision)
    {
        // Revision advances for routine output. Old/equal values remain valid;
        // only a future revision, which the caller could not have observed, is rejected.
        Some("session_revision")
    } else {
        None
    }?;

    Some(serde_json::json!({
        "sent": false,
        "reason": reason,
        "current": crate::status_feed::FeedSession::from(&current_view),
    }))
}

fn guard_send_text_request(
    store: &crate::session_state::SessionStateStore,
    id: usize,
    command: &str,
    args: &Value,
) -> Result<Option<SocketResponse>, String> {
    let Some(expectations) = send_text_expectations(command, args)? else {
        return Ok(None);
    };
    Ok(
        stale_send_text_result(store, &expectations).map(|result| SocketResponse {
            id,
            result: Some(result),
            error: None,
        }),
    )
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

async fn handle_connection(
    stream: TcpStream,
    app: AppHandle,
    auth: Arc<SocketAuth>,
    peer: SocketAddr,
) {
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
                    // Authenticate before anything else looks at the request,
                    // and drop the credential from the payload either way.
                    let provided_token = take_request_token(&mut parsed);
                    if !auth.authorize(provided_token.as_deref()) {
                        auth.note_rejection(
                            peer,
                            parsed.get("cmd").and_then(Value::as_str),
                            provided_token.is_some(),
                        );
                        let _ = write_json_line(&mut writer, &unauthorized_response()).await;
                        return;
                    }
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
                        let store = &app.state::<crate::AppState>().session_state_store;
                        match guard_send_text_request(store, id, &cmd, &args) {
                            Ok(Some(response)) => {
                                let _ = write_json_line(&mut writer, &response).await;
                                continue;
                            }
                            Ok(None) => {}
                            Err(error) => {
                                let response = SocketResponse {
                                    id,
                                    result: None,
                                    error: Some(error),
                                };
                                let _ = write_json_line(&mut writer, &response).await;
                                continue;
                            }
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

/// Directory that holds the socket discovery files (`~/.mycmux`).
fn get_discovery_dir() -> PathBuf {
    let path = crate::test_profile::runtime_dir().unwrap_or_else(|_| PathBuf::from("/tmp/.mycmux"));
    std::fs::create_dir_all(&path).ok();
    path
}

/// Get the path to the port file for socket discovery
fn get_port_file_path() -> PathBuf {
    let mut path = get_discovery_dir();
    path.push("mycmux.port");
    path
}

/// Get the path to the token file that authorizes socket callers.
fn get_token_file_path() -> PathBuf {
    let mut path = get_discovery_dir();
    path.push(SOCKET_TOKEN_FILE);
    path
}

/// Generate a new 32-byte hex token (same shape as the remote token).
fn generate_socket_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Write a fresh per-process token. The file is rewritten on every start, so a
/// token captured from an earlier run cannot drive this one.
fn write_socket_token(path: &Path) -> std::io::Result<String> {
    let token = generate_socket_token();
    std::fs::write(path, &token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(token)
}

/// Decide this process's socket access control and publish the token file.
fn prepare_socket_auth(token_file: &Path) -> SocketAuth {
    if auth_disabled_by_setting(std::env::var(SOCKET_AUTH_ENV).ok().as_deref()) {
        // Leave no stale secret behind: consumers must not keep sending a token
        // that this process would ignore.
        let _ = std::fs::remove_file(token_file);
        crate::diag_warn!(
            "socket",
            "{}=off — the local socket accepts unauthenticated requests",
            SOCKET_AUTH_ENV
        );
        return SocketAuth::disabled();
    }
    match write_socket_token(token_file) {
        Ok(token) => SocketAuth::enforcing(token),
        Err(error) => {
            // Fail closed. An unwritable token file must not silently restore
            // the old "any local process may drive the app" behaviour; keep the
            // unreadable token so every request is rejected until it is fixed.
            crate::diag_warn!(
                "socket",
                "Failed to write token file {}: {} — the local socket will reject every request until {}=off",
                token_file.display(),
                error,
                SOCKET_AUTH_ENV
            );
            SocketAuth::enforcing(generate_socket_token())
        }
    }
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
    // Publish the token before the port: a consumer that can see the port file
    // must already be able to read the token that goes with it.
    let auth = Arc::new(prepare_socket_auth(&get_token_file_path()));

    tauri::async_runtime::spawn(async move {
        // Bind to localhost with port 0 to get a random available port
        match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => {
                let addr = listener.local_addr().expect("Failed to get local address");
                let port = addr.port();

                // Write port to file for CLI tools to discover
                if let Err(e) = std::fs::write(&port_file, port.to_string()) {
                    crate::diag_warn!("socket", "Failed to write port file: {}", e);
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
                            crate::diag_warn!(
                                "socket",
                                "Rejected non-localhost connection from {}",
                                peer_addr
                            );
                            continue;
                        }

                        let app_clone = app.clone();
                        let auth = auth.clone();
                        tauri::async_runtime::spawn(async move {
                            handle_connection(stream, app_clone, auth, peer_addr).await;
                        });
                    }
                }
            }
            Err(e) => {
                crate::diag_warn!("socket", "Failed to bind TCP socket: {}", e);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_state::{
        AttentionKind, Evidence, EvidenceSignal, EvidenceSource, MonitorStatus, SessionStateStore,
    };

    fn attention_evidence(
        observed_at: u64,
        session_epoch: u64,
        attention: AttentionKind,
        attention_id: Option<&str>,
    ) -> Evidence {
        Evidence {
            observed_at,
            source: EvidenceSource::Hook,
            session_epoch: Some(session_epoch),
            process: None,
            signal: EvidenceSignal::Hook {
                attention,
                attention_id: attention_id.map(str::to_string),
                detail: None,
                confidence: 1.0,
                stale_after: 60_000,
            },
        }
    }

    fn enforcing_auth() -> SocketAuth {
        SocketAuth::enforcing("a".repeat(64))
    }

    #[test]
    fn valid_token_is_accepted_and_stripped_from_the_request() {
        let auth = enforcing_auth();
        let mut request = serde_json::json!({
            "cmd": "pane.list_all",
            "args": {},
            "token": "a".repeat(64),
        });

        let provided = take_request_token(&mut request);

        assert_eq!(provided.as_deref(), Some("a".repeat(64).as_str()));
        assert!(auth.authorize(provided.as_deref()));
        // The credential must not reach the frontend bridge or any log line.
        assert_eq!(
            request,
            serde_json::json!({ "cmd": "pane.list_all", "args": {} })
        );
    }

    #[test]
    fn missing_wrong_and_non_string_tokens_are_rejected() {
        let auth = enforcing_auth();

        assert!(!auth.authorize(None));
        assert!(!auth.authorize(Some("")));
        assert!(!auth.authorize(Some(&format!("{}b", "a".repeat(63)))));
        assert!(!auth.authorize(Some("a")));

        let mut numeric = serde_json::json!({ "cmd": "pane.list_all", "token": 7 });
        assert_eq!(take_request_token(&mut numeric), None);
        assert_eq!(numeric, serde_json::json!({ "cmd": "pane.list_all" }));
    }

    #[test]
    fn disabled_auth_accepts_requests_with_and_without_a_token() {
        let auth = SocketAuth::disabled();

        assert!(auth.authorize(None));
        assert!(auth.authorize(Some("whatever")));
    }

    #[test]
    fn only_the_documented_off_value_disables_enforcement() {
        // Parameter seam: the env var is read once at startup, never in tests.
        assert!(auth_disabled_by_setting(Some("off")));
        assert!(auth_disabled_by_setting(Some(" OFF ")));
        assert!(!auth_disabled_by_setting(None));
        assert!(!auth_disabled_by_setting(Some("")));
        assert!(!auth_disabled_by_setting(Some("false")));
        assert!(!auth_disabled_by_setting(Some("0")));
        assert!(!auth_disabled_by_setting(Some("offline")));
    }

    #[test]
    fn unauthorized_reply_is_the_documented_wire_shape() {
        assert_eq!(
            serde_json::to_string(&unauthorized_response()).unwrap(),
            r#"{"ok":false,"error":"unauthorized"}"#
        );
    }

    #[test]
    fn rejection_logging_reports_once_per_window_and_counts_the_rest() {
        let throttle = RejectionLogThrottle::new();

        assert_eq!(throttle.take_report(1_000, 60_000), Some(0));
        assert_eq!(throttle.take_report(1_001, 60_000), None);
        assert_eq!(throttle.take_report(60_999, 60_000), None);
        // Window elapsed: report, carrying the retries that were swallowed.
        assert_eq!(throttle.take_report(61_000, 60_000), Some(2));
        assert_eq!(throttle.take_report(61_001, 60_000), None);
        assert_eq!(throttle.take_report(200_000, 60_000), Some(1));
    }

    #[test]
    fn socket_tokens_are_fresh_64_char_hex_written_next_to_the_port_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(SOCKET_TOKEN_FILE);

        let first = write_socket_token(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));

        // Per-process lifetime: restarting overwrites the previous secret.
        let second = write_socket_token(&path).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), second);
        assert!(!SocketAuth::enforcing(second).authorize(Some(&first)));
    }

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

    #[test]
    fn send_text_without_expectations_stays_on_legacy_frontend_path() {
        let store = SessionStateStore::new();
        assert!(guard_send_text_request(
            &store,
            41,
            "pane.send_text",
            &serde_json::json!({
                "sessionId": "session-a",
                "text": "yes",
                "enter": true,
            }),
        )
        .unwrap()
        .is_none());
        assert!(
            guard_send_text_request(&store, 42, "workspace.list", &serde_json::json!({}))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn send_text_expectations_accept_snake_and_camel_case_aliases() {
        let snake = send_text_expectations(
            "pane.send_text",
            &serde_json::json!({
                "session_id": "session-a",
                "expected_session_epoch": 7,
                "expected_attention_id": "attention-a",
                "expected_session_revision": 11,
            }),
        )
        .unwrap()
        .unwrap();
        let camel = send_text_expectations(
            "pane.send_text",
            &serde_json::json!({
                "sessionId": "session-a",
                "expectedSessionEpoch": 7,
                "expectedAttentionId": "attention-a",
                "expectedSessionRevision": 11,
            }),
        )
        .unwrap()
        .unwrap();

        assert_eq!(snake, camel);
        assert!(send_text_expectations(
            "pane.send_text",
            &serde_json::json!({
                "sessionId": "session-a",
                "expectedSessionEpoch": null,
            }),
        )
        .is_err());
        assert!(send_text_expectations(
            "pane.send_text",
            &serde_json::json!({
                "sessionId": "session-a",
                "expected_session_epoch": 7,
                "expectedSessionEpoch": 8,
            }),
        )
        .is_err());
    }

    #[test]
    fn guarded_send_rejects_unknown_session_with_structured_result() {
        let response = guard_send_text_request(
            &SessionStateStore::new(),
            43,
            "pane.send_text",
            &serde_json::json!({
                "sessionId": "missing",
                "expectedSessionEpoch": 1,
            }),
        )
        .unwrap()
        .unwrap();

        assert_eq!(response.id, 43);
        assert_eq!(response.error, None);
        assert_eq!(
            response.result.unwrap(),
            serde_json::json!({
                "sent": false,
                "reason": "unknown_session",
                "current": null,
            })
        );
    }

    #[test]
    fn guarded_send_rejects_epoch_mismatch_and_returns_latest_feed_view() {
        let store = SessionStateStore::new();
        store.ingest(
            "session-a",
            Evidence::monitor_status(10, 7, MonitorStatus::Idle, None),
        );
        let result = stale_send_text_result(
            &store,
            &SendTextExpectations {
                session_id: "session-a".to_string(),
                session_epoch: Some(6),
                attention_id: None,
                session_revision: None,
            },
        )
        .unwrap();

        assert_eq!(result["sent"], false);
        assert_eq!(result["reason"], "session_epoch");
        assert_eq!(result["current"]["session_id"], "session-a");
        assert_eq!(result["current"]["session_revision"], 1);
        assert_eq!(result["current"]["status"]["session_epoch"], 7);
    }

    #[test]
    fn guarded_send_rejects_changed_and_resolved_attention() {
        let store = SessionStateStore::new();
        store.ingest(
            "session-a",
            Evidence::monitor_status(10, 7, MonitorStatus::Idle, None),
        );
        store.ingest(
            "session-a",
            attention_evidence(20, 7, AttentionKind::Input, Some("attention-a")),
        );
        let expected_a = SendTextExpectations {
            session_id: "session-a".to_string(),
            session_epoch: None,
            attention_id: Some("attention-a".to_string()),
            session_revision: None,
        };
        assert_eq!(stale_send_text_result(&store, &expected_a), None);

        store.ingest(
            "session-a",
            attention_evidence(30, 7, AttentionKind::Approval, Some("attention-b")),
        );
        let changed = stale_send_text_result(&store, &expected_a).unwrap();
        assert_eq!(changed["reason"], "attention_id");
        assert_eq!(
            changed["current"]["status"]["attention"]["attention_id"],
            "attention-b"
        );

        store.ingest(
            "session-a",
            attention_evidence(40, 7, AttentionKind::None, None),
        );
        let expected_b = SendTextExpectations {
            attention_id: Some("attention-b".to_string()),
            ..expected_a
        };
        let resolved = stale_send_text_result(&store, &expected_b).unwrap();
        assert_eq!(resolved["reason"], "attention_id");
        assert_eq!(
            resolved["current"]["status"]["attention"]["attention_id"],
            Value::Null
        );
    }

    #[test]
    fn guarded_send_allows_old_or_equal_revision_and_rejects_future_revision() {
        let store = SessionStateStore::new();
        let current = store.ingest(
            "session-a",
            Evidence::monitor_status(10, 7, MonitorStatus::Idle, None),
        );
        assert_eq!(current.session_revision, 1);

        for expected_revision in [0, 1] {
            assert_eq!(
                stale_send_text_result(
                    &store,
                    &SendTextExpectations {
                        session_id: "session-a".to_string(),
                        session_epoch: None,
                        attention_id: None,
                        session_revision: Some(expected_revision),
                    },
                ),
                None
            );
        }
        let future = stale_send_text_result(
            &store,
            &SendTextExpectations {
                session_id: "session-a".to_string(),
                session_epoch: None,
                attention_id: None,
                session_revision: Some(2),
            },
        )
        .unwrap();
        assert_eq!(future["reason"], "session_revision");
        assert_eq!(future["current"]["session_revision"], 1);
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
