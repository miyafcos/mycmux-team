//! Opt-in, one-thread Codex experiment. No PTY, transcript, launcher or live-pane access.
mod protocol;
pub use protocol::ExperimentSnapshot;

use protocol::{
    initialize_params, interrupt_params, pinned_user_agent, steer_params, thread_start_params,
    turn_start_params, validate_id, validate_text, ProtocolState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Weak,
};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

pub const PINNED_VERSION: &str = "0.160.0";
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_FRAME_BYTES: usize = 512 * 1024;
type Writer = Box<dyn AsyncWrite + Unpin + Send>;

#[derive(Debug, Clone)]
enum RpcFailure {
    Rejected(String),
    Unknown(String),
}
impl RpcFailure {
    fn message(&self) -> String {
        match self {
            Self::Rejected(s) | Self::Unknown(s) => s.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlReceipt {
    pub operation_id: String,
    pub request_id: String,
    pub method: String,
    pub turn_id: String,
    pub status: String,
    pub accepted: bool,
    pub observed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentCommand {
    pub operation: String,
    pub operation_id: String,
    pub expected_turn_id: Option<String>,
    pub text: Option<String>,
}

struct Client {
    writer: Mutex<Writer>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, RpcFailure>>>>,
    core: Mutex<ProtocolState>,
    actions: Mutex<()>,
    controls: Mutex<HashMap<String, (Value, ControlReceipt)>>,
    child: Mutex<Option<Child>>,
    closed: AtomicBool,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A bounded line reader; a malformed server cannot allocate an unbounded JSON line.
async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|_| "app-server stdout failed")?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("incomplete app-server JSON frame".into())
            };
        }
        let newline = available.iter().position(|&c| c == b'\n');
        let take = newline.map_or(available.len(), |i| i + 1);
        if bytes.len() + take > MAX_FRAME_BYTES {
            return Err("app-server frame exceeds 512 KiB".into());
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            return serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "invalid app-server JSON frame".into());
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin + Send>(client: Weak<Client>, reader: R) {
    let mut reader = BufReader::new(reader);
    loop {
        let frame = read_frame(&mut reader).await;
        let Some(client) = client.upgrade() else {
            return;
        };
        let frame = match frame {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                client.fail("app-server closed stdout").await;
                return;
            }
            Err(error) => {
                client.fail(&error).await;
                return;
            }
        };
        if let Some(method) = frame.get("method").and_then(Value::as_str) {
            if let Some(id) = frame.get("id") {
                // Never turn unsupported approval/input/auth requests into implicit acceptance.
                let _ = client.write(&json!({"id":id,"error":{"code":-32601,"message":"unsupported by mycmux one-turn experiment"}})).await;
                client.core.lock().await.record(
                    &format!("{method}:unsupported"),
                    "adapter",
                    None,
                    now_ms(),
                );
            } else {
                client
                    .core
                    .lock()
                    .await
                    .receive_notification(method, &frame["params"], now_ms());
            }
        } else if let Some(id) = frame.get("id").and_then(Value::as_str) {
            if let Some(sender) = client.pending.lock().await.remove(id) {
                let result = if let Some(error) = frame.get("error") {
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("app-server rejected request");
                    let prefix = if error.get("code").and_then(Value::as_i64) == Some(-32601) {
                        "unsupported: "
                    } else {
                        "rejected: "
                    };
                    Err(RpcFailure::Rejected(format!(
                        "{prefix}{}",
                        message.chars().take(512).collect::<String>()
                    )))
                } else if let Some(result) = frame.get("result") {
                    Ok(result.clone())
                } else {
                    Err(RpcFailure::Unknown("invalid app-server response".into()))
                };
                let _ = sender.send(result);
            }
        }
    }
}

impl Client {
    fn with_io<W, R>(writer: W, reader: R, child: Option<Child>) -> Arc<Self>
    where
        W: AsyncWrite + Unpin + Send + 'static,
        R: AsyncRead + Unpin + Send + 'static,
    {
        let mut core = ProtocolState::default();
        core.snapshot.connection_id = Some(uuid::Uuid::new_v4().to_string());
        core.snapshot.process_state = "running".into();
        let client = Arc::new(Self {
            writer: Mutex::new(Box::new(writer)),
            pending: Mutex::new(HashMap::new()),
            core: Mutex::new(core),
            actions: Mutex::new(()),
            controls: Mutex::new(HashMap::new()),
            child: Mutex::new(child),
            closed: AtomicBool::new(false),
        });
        tokio::spawn(read_loop(Arc::downgrade(&client), reader));
        client
    }

    async fn write(&self, message: &Value) -> Result<(), RpcFailure> {
        if self.closed.load(Ordering::Acquire) {
            return Err(RpcFailure::Unknown(
                "connection closed; do not resend".into(),
            ));
        }
        let mut bytes = serde_json::to_vec(message)
            .map_err(|_| RpcFailure::Unknown("serialization failed".into()))?;
        bytes.push(b'\n');
        tokio::time::timeout(RPC_TIMEOUT, async {
            let mut writer = self.writer.lock().await;
            writer.write_all(&bytes).await.map_err(|_| {
                RpcFailure::Unknown("app-server write failed; outcome unknown".into())
            })?;
            writer
                .flush()
                .await
                .map_err(|_| RpcFailure::Unknown("app-server flush failed; outcome unknown".into()))
        })
        .await
        .map_err(|_| RpcFailure::Unknown("app-server write timed out; outcome unknown".into()))?
    }

    async fn request_with_timeout(
        &self,
        id: &str,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcFailure> {
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.contains_key(id) {
                return Err(RpcFailure::Rejected(
                    "duplicate in-flight request ID".into(),
                ));
            }
            pending.insert(id.into(), sender);
        }
        let result = match tokio::time::timeout(timeout, async {
            self.write(&json!({"id":id,"method":method,"params":params}))
                .await?;
            receiver.await.unwrap_or_else(|_| {
                Err(RpcFailure::Unknown(
                    "connection lost; outcome unknown".into(),
                ))
            })
        })
        .await
        {
            Ok(result) => result,
            Err(_) => {
                self.fail("request timed out; outcome unknown, do not resend")
                    .await;
                Err(RpcFailure::Unknown(
                    "request timed out; outcome unknown, do not resend".into(),
                ))
            }
        };
        self.pending.lock().await.remove(id);
        if let Err(RpcFailure::Unknown(reason)) = &result {
            self.fail(reason).await;
        }
        result
    }

    async fn request(&self, id: &str, method: &str, params: Value) -> Result<Value, RpcFailure> {
        self.request_with_timeout(id, method, params, RPC_TIMEOUT)
            .await
    }

    async fn initialize(&self, cwd: &str) -> Result<(), String> {
        let initialized = self
            .request("initialize", "initialize", initialize_params())
            .await
            .map_err(|e| e.message())?;
        let user_agent = initialized
            .get("userAgent")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !pinned_user_agent(user_agent) {
            return Err("unsupported: app-server initialize version differs from 0.160.0".into());
        }
        self.write(&json!({"method":"initialized","params":{}}))
            .await
            .map_err(|e| e.message())?;
        let requested = thread_start_params(cwd);
        let result = self
            .request("thread:start", "thread/start", requested.clone())
            .await
            .map_err(|e| e.message())?;
        let mut core = self.core.lock().await;
        core.opened_thread(requested, &result)?;
        core.snapshot.cli_version = Some(PINNED_VERSION.into());
        core.record("thread/start:accepted", "appServerResponse", None, now_ms());
        Ok(())
    }

    async fn send(&self, operation: &str, text: &str) -> Result<Value, String> {
        let _action = self.actions.lock().await;
        let (thread, request_id) = {
            let mut core = self.core.lock().await;
            if !core.reserve_send(operation, text, now_ms())? {
                return Ok(json!({"duplicate":true,"delivery":core.snapshot.delivery}));
            }
            (
                core.snapshot.thread_id.clone().ok_or("no thread")?,
                core.snapshot.delivery.as_ref().unwrap().request_id.clone(),
            )
        };
        let response = self
            .request(
                &request_id,
                "turn/start",
                turn_start_params(&thread, text, operation),
            )
            .await;
        let mut core = self.core.lock().await;
        match response {
            Ok(result) => {
                if let Err(error) = core.accept_send(&result, now_ms()) {
                    core.snapshot.error = Some(error);
                    if let Some(delivery) = &mut core.snapshot.delivery {
                        delivery.status = "unknown".into();
                    }
                }
            }
            Err(error) => {
                core.snapshot.error = Some(error.message());
                if let Some(delivery) = &mut core.snapshot.delivery {
                    if delivery.completed_at_ms.is_none() {
                        delivery.status = match error {
                            RpcFailure::Rejected(_) => "rejected",
                            RpcFailure::Unknown(_) => "unknown",
                        }
                        .into();
                    }
                }
            }
        }
        Ok(json!({"duplicate":false,"delivery":core.snapshot.delivery,"error":core.snapshot.error}))
    }

    async fn control(
        &self,
        operation: &str,
        id: &str,
        expected: &str,
        text: Option<&str>,
    ) -> Result<Value, String> {
        validate_id(id)?;
        let method = match operation {
            "steer" => {
                validate_text(text.unwrap_or(""))?;
                "turn/steer"
            }
            "interrupt" => "turn/interrupt",
            _ => return Err(format!("unsupported: {operation}")),
        };
        let _action = self.actions.lock().await;
        let identity = json!({"method":method,"turnId":expected,"text":text});
        {
            let controls = self.controls.lock().await;
            if let Some((prior, receipt)) = controls.get(id) {
                if *prior != identity {
                    return Err("control operation ID reused with different input".into());
                }
                return Ok(json!({"duplicate":true,"control":receipt}));
            }
            if controls.len() >= 32 {
                return Err("unsupported: control operation limit for this experiment".into());
            }
        }
        let (thread, turn) = self.core.lock().await.active_turn(expected)?;
        let params = if operation == "steer" {
            steer_params(&thread, &turn, text.unwrap(), id)
        } else {
            interrupt_params(&thread, &turn)
        };
        let request_id = format!("{operation}:{id}");
        let response = self.request(&request_id, method, params).await;
        let receipt = match response {
            Ok(result)
                if operation != "steer"
                    || result.get("turnId").and_then(Value::as_str) == Some(turn.as_str()) =>
            {
                ControlReceipt {
                    operation_id: id.into(),
                    request_id,
                    method: method.into(),
                    turn_id: turn,
                    status: "accepted".into(),
                    accepted: true,
                    observed: false,
                    error: None,
                }
            }
            result => {
                let (status, error) = match result {
                    Err(RpcFailure::Rejected(error)) => ("rejected", error),
                    Err(RpcFailure::Unknown(error)) => ("unknown", error),
                    _ => (
                        "unknown",
                        "steer response did not match the expected turn".into(),
                    ),
                };
                ControlReceipt {
                    operation_id: id.into(),
                    request_id,
                    method: method.into(),
                    turn_id: turn,
                    status: status.into(),
                    accepted: false,
                    observed: false,
                    error: Some(error),
                }
            }
        };
        self.core.lock().await.record(
            &format!("{method}:{}", receipt.status),
            "appServerResponse",
            Some(id.into()),
            now_ms(),
        );
        self.controls
            .lock()
            .await
            .insert(id.into(), (identity, receipt.clone()));
        Ok(json!({"duplicate":false,"control":receipt}))
    }

    async fn fail(&self, reason: &str) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.core.lock().await.connection_lost(reason, now_ms());
            for (_, sender) in self.pending.lock().await.drain() {
                let _ = sender.send(Err(RpcFailure::Unknown(reason.into())));
            }
        }
    }

    async fn close(&self) {
        self.fail("experiment connection closed").await;
        let _ = self.writer.lock().await.shutdown().await;
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.core.lock().await.snapshot.process_state = "exited".into();
    }
}

#[derive(Default)]
pub struct CodexAppServerState {
    enabled: AtomicBool,
    lifecycle: Mutex<()>,
    client: Mutex<Option<Arc<Client>>>,
}

impl CodexAppServerState {
    pub async fn snapshot(&self) -> ExperimentSnapshot {
        let client = self.client.lock().await.clone();
        let mut snapshot = if let Some(client) = client {
            client.core.lock().await.snapshot.clone()
        } else {
            ExperimentSnapshot::default()
        };
        snapshot.enabled = self.enabled.load(Ordering::Acquire);
        snapshot
    }

    async fn set_enabled(&self, enabled: bool) -> ExperimentSnapshot {
        self.enabled.store(enabled, Ordering::Release);
        if !enabled {
            self.close().await;
        }
        self.snapshot().await
    }

    async fn close(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        if let Some(client) = self.client.lock().await.clone() {
            client.close().await;
        }
    }

    fn require_enabled(&self) -> Result<(), String> {
        if !self.enabled.load(Ordering::Acquire) {
            Err("unsupported: Codex app-server experiment is disabled".into())
        } else {
            Ok(())
        }
    }

    async fn start(
        &self,
        cwd: &str,
        executable: Option<&str>,
    ) -> Result<ExperimentSnapshot, String> {
        self.require_enabled()?;
        let _lifecycle = self.lifecycle.lock().await;
        self.require_enabled()?;
        if let Some(client) = self.client.lock().await.clone() {
            if !client.closed.load(Ordering::Acquire) {
                return Err("experiment connection is already running".into());
            }
            client.close().await;
        }
        let cwd = Path::new(cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err("experiment cwd must be an existing absolute directory".into());
        }
        let program = resolve_codex(executable)?;
        let version = tokio::time::timeout(
            Duration::from_secs(10),
            codex_command(&program).arg("--version").output(),
        )
        .await
        .map_err(|_| "Codex version check timed out")?
        .map_err(|_| "Codex version check failed")?;
        if !version.status.success()
            || String::from_utf8_lossy(&version.stdout).trim()
                != format!("codex-cli {PINNED_VERSION}")
        {
            return Err("unsupported: experiment requires codex-cli 0.160.0".into());
        }
        self.require_enabled()?;
        let mut child = codex_command(&program)
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "could not start the pinned Codex app-server")?;
        let writer = child.stdin.take().ok_or("app-server stdin unavailable")?;
        let reader = child.stdout.take().ok_or("app-server stdout unavailable")?;
        let client = Client::with_io(writer, reader, Some(child));
        *self.client.lock().await = Some(client.clone());
        let result = client.initialize(&cwd.to_string_lossy()).await;
        if let Err(error) = result {
            client.close().await;
            return Err(error);
        }
        if let Err(error) = self.require_enabled() {
            client.close().await;
            return Err(error);
        }
        Ok(self.snapshot().await)
    }

    async fn command(&self, request: ExperimentCommand) -> Result<Value, String> {
        // Unknown operations are never translated to another operation, even while disabled.
        if !["send", "steer", "interrupt"].contains(&request.operation.as_str()) {
            return Err(format!("unsupported: {}", request.operation));
        }
        self.require_enabled()?;
        let client = self
            .client
            .lock()
            .await
            .clone()
            .ok_or("experiment is not connected")?;
        if request.operation == "send" {
            client
                .send(&request.operation_id, request.text.as_deref().unwrap_or(""))
                .await
        } else {
            client
                .control(
                    &request.operation,
                    &request.operation_id,
                    request.expected_turn_id.as_deref().unwrap_or(""),
                    request.text.as_deref(),
                )
                .await
        }
    }
}

fn codex_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.kill_on_drop(true);
    // Child-only isolation; neither mutate nor dump the parent's environment or credentials.
    command
        .env_clear()
        .envs(std::env::vars().filter(|(key, _)| {
            let key = key.to_ascii_uppercase();
            !key.starts_with("MYCMUX_") && !key.starts_with("__CMUX_")
        }));
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

fn is_native_executable(path: &Path) -> bool {
    use std::io::Read as _;
    let mut magic = [0_u8; 4];
    if !path.is_file()
        || std::fs::File::open(path)
            .and_then(|mut file| file.read_exact(&mut magic))
            .is_err()
    {
        return false;
    }
    if cfg!(target_os = "windows") {
        magic.starts_with(b"MZ")
    } else if cfg!(target_os = "macos") {
        matches!(
            magic,
            [0xfe, 0xed, 0xfa, 0xce]
                | [0xce, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xcf, 0xfa, 0xed, 0xfe]
                | [0xca, 0xfe, 0xba, 0xbe]
                | [0xbe, 0xba, 0xfe, 0xca]
                | [0xca, 0xfe, 0xba, 0xbf]
                | [0xbf, 0xba, 0xfe, 0xca]
        )
    } else {
        magic == *b"\x7fELF"
    }
}

fn resolve_codex(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = explicit.filter(|path| !path.trim().is_empty()) {
        let path = PathBuf::from(path);
        if !path.is_absolute() || !path.is_file() {
            return Err("Codex executable must be an existing absolute file".into());
        }
        #[cfg(target_os = "windows")]
        if path.extension().and_then(|value| value.to_str()) != Some("exe") {
            return Err("unsupported: select the native Codex .exe, not a shell shim".into());
        }
        if !is_native_executable(&path) {
            return Err("unsupported: select a native Codex binary, not a shell/Node shim".into());
        }
        return Ok(path);
    }
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let triple = match (platform, arch) {
        ("win32", "x64") => "x86_64-pc-windows-msvc",
        ("win32", _) => "aarch64-pc-windows-msvc",
        ("darwin", "x64") => "x86_64-apple-darwin",
        ("darwin", _) => "aarch64-apple-darwin",
        ("linux", "x64") => "x86_64-unknown-linux-musl",
        _ => "aarch64-unknown-linux-musl",
    };
    let binary = if cfg!(target_os = "windows") {
        "codex.exe"
    } else {
        "codex"
    };
    let suffix = PathBuf::from("vendor")
        .join(triple)
        .join("bin")
        .join(binary);
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            // Native first; npm's packaged binary avoids an unowned shell/Node child.
            let candidates = [
                directory.join(binary),
                directory
                    .join("node_modules/@openai/codex/node_modules/@openai")
                    .join(format!("codex-{platform}-{arch}"))
                    .join(&suffix),
                directory
                    .join("node_modules/@openai")
                    .join(format!("codex-{platform}-{arch}"))
                    .join(&suffix),
                directory.join("node_modules/@openai/codex").join(&suffix),
            ];
            for candidate in candidates {
                if is_native_executable(&candidate) {
                    return Ok(candidate);
                }
            }
        }
    }
    Err("unsupported: native Codex executable was not found; supply its absolute path".into())
}

#[tauri::command]
pub async fn codex_app_server_set_enabled(
    state: tauri::State<'_, CodexAppServerState>,
    enabled: bool,
) -> Result<ExperimentSnapshot, String> {
    Ok(state.set_enabled(enabled).await)
}

#[tauri::command]
pub async fn codex_app_server_start(
    state: tauri::State<'_, CodexAppServerState>,
    cwd: String,
    executable: Option<String>,
) -> Result<ExperimentSnapshot, String> {
    state.start(&cwd, executable.as_deref()).await
}

#[tauri::command]
pub async fn codex_app_server_command(
    state: tauri::State<'_, CodexAppServerState>,
    request: ExperimentCommand,
) -> Result<Value, String> {
    state.command(request).await
}

#[tauri::command]
pub async fn codex_app_server_status(
    state: tauri::State<'_, CodexAppServerState>,
) -> Result<ExperimentSnapshot, String> {
    Ok(state.snapshot().await)
}

#[tauri::command]
pub async fn codex_app_server_close(
    state: tauri::State<'_, CodexAppServerState>,
) -> Result<ExperimentSnapshot, String> {
    state.close().await;
    Ok(state.snapshot().await)
}

#[cfg(test)]
mod tests;
