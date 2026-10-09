//! Explicit settings experiment: one owned stdio process and one root conversation.
//! Never registers a PTY, installs hooks, reads credential files or deletes conversations.
mod protocol;
pub use protocol::{DshDelivery, DshRead, DshRunRef, DshState};

use protocol::{initialize_params, opaque_id, Core, DshPermission};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Weak};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

pub const PINNED_VERSION: &str = "0.2.0-rc.2";
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_FRAME_BYTES: usize = 256 * 1024;
const MAX_PERMISSIONS: usize = 8;
const MAX_REQUESTS: usize = 512;
type Writer = Box<dyn AsyncWrite + Unpin + Send>;

#[derive(Clone, Debug)]
pub(super) enum RpcFailure { Rejected, Unknown }

struct Pending {
    sender: oneshot::Sender<Result<Value, RpcFailure>>,
    prompt: Option<String>,
}

struct PermissionWire { id: Value, allow: Option<String>, reject: Option<String> }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DshStartRequest {
    pub executable: String,
    pub cwd: String,
    pub dsh_home: Option<String>,
    pub resume: Option<DshRunRef>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DshPromptRequest {
    pub expected_run: DshRunRef,
    pub operation_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DshPermissionAnswer {
    pub expected_run: DshRunRef,
    pub permission_id: String,
    pub choice: String,
}

struct Client {
    writer: Mutex<Writer>,
    pending: Mutex<HashMap<String, Pending>>,
    completed: Mutex<HashSet<String>>,
    permissions: Mutex<HashMap<String, PermissionWire>>,
    core: Mutex<Core>,
    actions: Mutex<()>,
    child: Mutex<Option<Child>>,
    lost: AtomicBool,
    counter: AtomicU64,
    prefix: String,
}

async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Value>, &'static str> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(|_| "ACP stdout read failed")?;
        if available.is_empty() {
            return if bytes.is_empty() { Ok(None) } else { Err("incomplete ACP frame") };
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let take = newline.map_or(available.len(), |i| i + 1);
        if bytes.len() + take > MAX_FRAME_BYTES { return Err("ACP frame exceeds 256 KiB"); }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid ACP JSON; stdout must contain only JSON-RPC")?;
            validate_frame(&value)?;
            return Ok(Some(value));
        }
    }
}

fn validate_frame(frame: &Value) -> Result<(), &'static str> {
    if !frame.is_object() || frame.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("invalid ACP JSON-RPC envelope");
    }
    if let Some(id) = frame.get("id") {
        if !(id.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128) || id.as_i64().is_some()) {
            return Err("invalid ACP request ID");
        }
    }
    if let Some(method) = frame.get("method") {
        if !method.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128)
            || frame.get("result").is_some() || frame.get("error").is_some()
            || frame.get("params").is_some_and(|p| !p.is_object()) {
            return Err("invalid ACP request or notification");
        }
    } else if frame.get("id").is_none() || (frame.get("result").is_some() == frame.get("error").is_some()) {
        return Err("invalid ACP reply");
    } else if let Some(error) = frame.get("error") {
        if error.get("code").and_then(Value::as_i64).is_none() || error.get("message").and_then(Value::as_str).is_none() {
            return Err("invalid ACP error reply");
        }
    }
    Ok(())
}

impl Client {
    fn from_io<R, W>(reader: R, writer: W, child: Option<Child>, run: DshRunRef) -> Arc<Self>
    where R: AsyncRead + Unpin + Send + 'static, W: AsyncWrite + Unpin + Send + 'static {
        let prefix = format!("{}:{}", run.run_id, run.generation);
        let mut core = Core::default();
        core.state.enabled = true;
        core.state.run = Some(run);
        core.state.process = "running".into();
        let client = Arc::new(Self {
            writer: Mutex::new(Box::new(writer)), pending: Mutex::new(HashMap::new()),
            completed: Mutex::new(HashSet::new()), permissions: Mutex::new(HashMap::new()),
            core: Mutex::new(core), actions: Mutex::new(()), child: Mutex::new(child),
            lost: AtomicBool::new(false), counter: AtomicU64::new(0), prefix,
        });
        tokio::spawn(read_loop(Arc::downgrade(&client), reader));
        client
    }

    fn next_id(&self) -> Result<String, String> {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        if n >= MAX_REQUESTS as u64 { return Err("dsh request limit reached; reconnect explicitly".into()); }
        Ok(format!("{}:{n}", self.prefix))
    }

    async fn write(&self, frame: Value) -> Result<(), RpcFailure> {
        if self.lost.load(Ordering::Acquire) { return Err(RpcFailure::Unknown); }
        let mut bytes = serde_json::to_vec(&frame).map_err(|_| RpcFailure::Unknown)?;
        bytes.push(b'\n');
        tokio::time::timeout(RPC_TIMEOUT, async {
            let mut writer = self.writer.lock().await;
            if self.lost.load(Ordering::Acquire) { return Err(RpcFailure::Unknown); }
            writer.write_all(&bytes).await.map_err(|_| RpcFailure::Unknown)?;
            writer.flush().await.map_err(|_| RpcFailure::Unknown)
        }).await.map_err(|_| RpcFailure::Unknown)?
    }

    async fn fail(&self, reason: &str) {
        self.lost.store(true, Ordering::Release);
        self.core.lock().await.lost(reason);
        self.permissions.lock().await.clear();
        for (_, pending) in self.pending.lock().await.drain() { let _ = pending.sender.send(Err(RpcFailure::Unknown)); }
    }

    async fn request(&self, id: String, method: &str, params: Value, prompt: Option<String>, timeout: Duration) -> Result<Value, RpcFailure> {
        if self.lost.load(Ordering::Acquire) { return Err(RpcFailure::Unknown); }
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), Pending { sender, prompt });
        let result = tokio::time::timeout(timeout, async {
            self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).await?;
            receiver.await.unwrap_or(Err(RpcFailure::Unknown))
        }).await.unwrap_or(Err(RpcFailure::Unknown));
        self.pending.lock().await.remove(&id);
        if matches!(result, Err(RpcFailure::Unknown)) { self.fail("ACP reply lost or timed out; outcome unknown, do not resend").await; }
        result
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id()?;
        self.request(id, method, params, None, RPC_TIMEOUT).await.map_err(|failure| match failure {
            RpcFailure::Rejected => "ACP rejected request; remote details withheld".into(),
            RpcFailure::Unknown => "ACP outcome unknown; do not resend".into(),
        })
    }

    async fn open(&self, version: &str, resume: Option<&DshRunRef>) -> Result<(), String> {
        self.core.lock().await.state.executable_version = Some(version.into());
        let initialized = self.call("initialize", initialize_params()).await?;
        self.core.lock().await.initialized(&initialized)?;
        let cwd = self.core.lock().await.state.run.as_ref().expect("owned run").cwd.clone();
        let (method, params) = if let Some(saved) = resume {
            if !self.core.lock().await.state.resume_supported { return Err("unsupported: ACP resume/list not advertised".into()); }
            let id = saved.conv_id.as_deref().ok_or("no saved conversation ID")?;
            opaque_id(id)?;
            if saved.cwd != cwd { return Err("saved dsh cwd mismatch".into()); }
            // Resume replies contain configOptions, not ID/cwd. Validate the inactive root first.
            self.verify_saved(id, &cwd).await?;
            ("session/resume", json!({"sessionId":id,"cwd":cwd,"mcpServers":[]}))
        } else { ("session/new", json!({"cwd":cwd,"mcpServers":[]})) };
        let response = self.call(method, params).await?;
        let mut core = self.core.lock().await;
        if self.lost.load(Ordering::Acquire) { return Err("ACP connection lost during session open; outcome unknown".into()); }
        core.opened(&response, resume.and_then(|r| r.conv_id.as_deref()))
    }

    async fn verify_saved(&self, id: &str, cwd: &str) -> Result<(), String> {
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        for _ in 0..16 {
            let mut params = json!({"cwd":cwd});
            if !cursor.is_null() { params["cursor"] = cursor.clone(); }
            let response = self.call("session/list", params).await?;
            let entries = response.get("sessions").and_then(Value::as_array).ok_or("invalid ACP session/list response")?;
            if entries.len() > 1024 { return Err("ACP session list exceeds bound".into()); }
            let mut matched = false;
            for entry in entries {
                if entry.get("sessionId").and_then(Value::as_str) == Some(id) {
                    if matched || entry.get("cwd").and_then(Value::as_str) != Some(cwd)
                        || entry.get("parentSession").is_some_and(|p| !p.is_null())
                        || entry.get("origin").and_then(Value::as_str) == Some("subagent") {
                        return Err("ACP saved conversation ID/cwd/root mismatch".into());
                    }
                    matched = true;
                }
            }
            if matched { return Ok(()); }
            cursor = response.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() { return Err("saved root conversation unavailable; no new-session fallback".into()); }
            let token = cursor.as_str().filter(|c| !c.is_empty() && c.len() <= 1024).ok_or("invalid ACP list cursor")?;
            if !seen.insert(token.to_string()) { return Err("repeated ACP list cursor".into()); }
        }
        Err("ACP session list page limit reached".into())
    }

    async fn prompt(self: &Arc<Self>, request: DshPromptRequest) -> Result<DshDelivery, String> {
        let _action = self.actions.lock().await;
        let id = self.next_id()?;
        let (fresh, receipt) = self.core.lock().await.reserve(&request.expected_run, &request.operation_id, &request.text, &id)?;
        if !fresh { return Ok(receipt); }
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), Pending { sender, prompt: Some(request.operation_id.clone()) });
        // Keep the action lock until prompt bytes are written. An immediate cancel
        // must never overtake the prompt and become a server-side no-op.
        if self.write(json!({"jsonrpc":"2.0","id":id,"method":"session/prompt",
            "params":{"sessionId":request.expected_run.conv_id,"prompt":[{"type":"text","text":request.text}]}})).await.is_err() {
            self.fail("ACP prompt write lost; outcome unknown, do not resend").await;
            return Ok(self.core.lock().await.state.delivery.clone().expect("reserved prompt"));
        }
        let client = self.clone();
        tokio::spawn(async move {
            let result = tokio::time::timeout(PROMPT_TIMEOUT, receiver).await
                .ok().and_then(Result::ok).unwrap_or(Err(RpcFailure::Unknown));
            client.pending.lock().await.remove(&id);
            if matches!(result, Err(RpcFailure::Unknown)) {
                client.fail("ACP prompt reply lost or timed out; outcome unknown, do not resend").await;
            }
            client.core.lock().await.settle(&request.operation_id, result);
        });
        Ok(receipt)
    }

    async fn cancel(self: &Arc<Self>, expected: &DshRunRef) -> Result<DshState, String> {
        let _action = self.actions.lock().await;
        let operation = {
            let core = self.core.lock().await;
            core.require_run(expected)?;
            core.inflight.clone()
        };
        if let Some(operation) = operation {
            if self.write(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":expected.conv_id}})).await.is_err() {
                self.fail("ACP cancel write failed; outcome unknown").await;
            } else {
                self.core.lock().await.cancel_requested();
                let client = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(RPC_TIMEOUT).await;
                    let still_pending = client.core.lock().await.inflight.as_deref() == Some(operation.as_str());
                    if still_pending { client.fail("ACP cancel settlement timed out; outcome unknown").await; }
                });
            }
        }
        Ok(self.snapshot().await)
    }

    async fn permission_request(&self, id: Value, params: &Value) -> Result<(), RpcFailure> {
        let mut core = self.core.lock().await;
        let valid = core.state.run.as_ref().and_then(|r| r.conv_id.as_deref())
            .is_some_and(|s| params.get("sessionId").and_then(Value::as_str) == Some(s));
        let mut permissions = self.permissions.lock().await;
        if !valid || core.inflight.is_none() || core.state.activity == "unknown"
            || permissions.len() >= MAX_PERMISSIONS || permissions.values().any(|p| p.id == id) {
            drop(permissions); drop(core);
            return self.write(json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}})).await;
        }
        let options = params.get("options").and_then(Value::as_array).filter(|o| o.len() <= 16);
        let mut allow = None;
        let mut reject = None;
        if let Some(options) = options {
            for option in options {
                let Some(option_id) = option.get("optionId").and_then(Value::as_str).filter(|s| s.len() <= 128 && !s.is_empty()) else { continue; };
                match option.get("kind").and_then(Value::as_str) {
                    Some("allow_once") => allow = Some(option_id.to_string()),
                    Some("reject_once") => reject = Some(option_id.to_string()),
                    _ => {}, // Never grant allow_always or expose remote names/tool payloads.
                }
            }
        }
        if (allow.is_none() && reject.is_none()) || (allow.is_some() && allow == reject) {
            drop(permissions); drop(core);
            return self.write(json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}})).await;
        }
        let permission_id = uuid::Uuid::new_v4().to_string();
        let operation_id = core.inflight.clone().expect("pending prompt");
        core.state.permissions.push(DshPermission { permission_id: permission_id.clone(),
            operation_id, allow_available: allow.is_some(), reject_available: reject.is_some() });
        permissions.insert(permission_id, PermissionWire { id, allow, reject });
        Ok(())
    }

    async fn answer(&self, answer: DshPermissionAnswer) -> Result<DshState, String> {
        let _action = self.actions.lock().await;
        self.core.lock().await.require_run(&answer.expected_run)?;
        let wire = self.permissions.lock().await.remove(&answer.permission_id).ok_or("stale dsh permission request")?;
        let option = match answer.choice.as_str() {
            "allow" => wire.allow.as_ref(), "reject" => wire.reject.as_ref(),
            _ => { self.permissions.lock().await.insert(answer.permission_id, wire); return Err("unsupported permission choice".into()); }
        };
        let Some(option) = option else {
            self.permissions.lock().await.insert(answer.permission_id, wire);
            return Err("permission choice was not offered".into());
        };
        let result = self.write(json!({"jsonrpc":"2.0","id":wire.id,"result":{"outcome":{"outcome":"selected","optionId":option}}})).await;
        if result.is_err() { self.fail("ACP permission response lost; outcome unknown").await; }
        self.core.lock().await.state.permissions.retain(|p| p.permission_id != answer.permission_id);
        Ok(self.snapshot().await)
    }

    async fn close_session(&self, expected: &DshRunRef) -> Result<DshState, String> {
        let _action = self.actions.lock().await;
        self.core.lock().await.require_run(expected)?;
        let response = self.call("session/close", json!({"sessionId":expected.conv_id})).await?;
        if !response.is_object() {
            self.fail("invalid ACP close reply; outcome unknown").await;
            return Err("ACP close outcome unknown".into());
        }
        let mut core = self.core.lock().await;
        core.state.session_closed = true;
        // A close reply does not substitute for the pending prompt's own settlement.
        if core.inflight.is_some() { core.lost("session closed without prompt settlement; outcome unknown"); }
        else { core.state.activity = "quiescent".into(); core.state.confidence = "observed".into(); }
        core.state.permissions.clear();
        drop(core);
        self.permissions.lock().await.clear();
        Ok(self.snapshot().await)
    }

    async fn snapshot(&self) -> DshState {
        let exited = if let Some(child) = self.child.lock().await.as_mut() { child.try_wait().ok().flatten().is_some() } else { false };
        if exited {
            if !self.lost.load(Ordering::Acquire) { self.fail("owned dsh process exited; unsettled outcome unknown").await; }
            self.core.lock().await.state.process = "exited".into();
        }
        self.core.lock().await.snapshot()
    }

    async fn stop(&self) {
        let state = self.snapshot().await;
        if !self.lost.load(Ordering::Acquire) && !state.session_closed {
            if let Some(run) = &state.run { let _ = self.close_session(run).await; }
        }
        let before_stop = self.core.lock().await.snapshot();
        let clean = before_stop.session_closed && before_stop.activity == "quiescent";
        self.fail("owned dsh process stopped; unsettled outcome unknown").await;
        let mut exited = true;
        let owned_child = self.child.lock().await.take();
        if let Some(mut child) = owned_child {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                // The child was created in its own group, never the app's or a PTY's.
                unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
            }
            #[cfg(windows)]
            if let Some(pid) = child.id() {
                let mut cleanup = Command::new("taskkill");
                cleanup.args(["/PID", &pid.to_string(), "/T", "/F"]).kill_on_drop(true)
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                let _ = tokio::time::timeout(RPC_TIMEOUT, cleanup.status()).await;
            }
            let _ = child.start_kill();
            exited = matches!(tokio::time::timeout(RPC_TIMEOUT, child.wait()).await, Ok(Ok(_)));
            if !exited { *self.child.lock().await = Some(child); }
        }
        let mut core = self.core.lock().await;
        core.state.process = if exited { "exited" } else { "unknown" }.into();
        core.state.error = if exited { before_stop.error } else { Some("owned dsh process stop could not be confirmed".into()) };
        if clean {
            core.state.activity = "quiescent".into();
            core.state.confidence = "observed".into();
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin + Send>(client: Weak<Client>, reader: R) {
    let mut reader = BufReader::new(reader);
    loop {
        let frame = read_frame(&mut reader).await;
        let Some(client) = client.upgrade() else { return; };
        if client.lost.load(Ordering::Acquire) { return; }
        let frame = match frame {
            Ok(Some(frame)) => frame,
            Ok(None) => { client.fail("ACP stdout EOF; unsettled outcome unknown").await; return; }
            Err(reason) => { client.fail(reason).await; return; }
        };
        if let Some(method) = frame.get("method").and_then(Value::as_str) {
            if let Some(id) = frame.get("id") {
                let result = if method == "session/request_permission" {
                    client.permission_request(id.clone(), &frame["params"]).await
                } else {
                    client.write(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"unsupported by mycmux dsh experiment"}})).await
                };
                if result.is_err() { client.fail("ACP client response write failed").await; return; }
            } else if method == "session/update" {
                client.core.lock().await.update(&frame["params"]);
            }
        } else {
            let id = frame["id"].as_str().map(str::to_string).unwrap_or_else(|| frame["id"].to_string());
            let pending = client.pending.lock().await.remove(&id);
            if let Some(pending) = pending {
                client.completed.lock().await.insert(id);
                let result = if frame.get("error").is_some() { Err(RpcFailure::Rejected) } else { Ok(frame["result"].clone()) };
                if let Some(operation) = pending.prompt {
                    client.core.lock().await.settle(&operation, result.clone());
                    client.permissions.lock().await.clear();
                    if client.core.lock().await.state.activity == "unknown" {
                        client.fail("invalid ACP prompt settlement; outcome unknown").await;
                        let _ = pending.sender.send(Err(RpcFailure::Unknown));
                        return;
                    }
                }
                let _ = pending.sender.send(result);
            } else if !client.completed.lock().await.contains(&id) {
                client.fail("unknown ACP reply ID; outcome unknown").await;
                return;
            } // A duplicate reply is ignored; it cannot complete another operation.
        }
    }
}

fn remove_child_env(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    name.starts_with("MYCMUX_") || name.starts_with("__CMUX_") || name.starts_with("CLAUDE")
        || name.starts_with("CODEX_") || ["API_KEY", "ACCESS_TOKEN", "AUTH_TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"].iter().any(|part| name.contains(part))
}

fn child_command(executable: &Path, cwd: &Path, dsh_home: Option<&Path>) -> Command {
    let mut command = Command::new(executable);
    command.current_dir(cwd).kill_on_drop(true);
    for (key, _) in std::env::vars_os() {
        if remove_child_env(&key.to_string_lossy()) { command.env_remove(key); }
    }
    if let Some(home) = dsh_home { command.env("DSH_HOME", home); }
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; command.as_std_mut().process_group(0); }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

fn existing_directory(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if !path.is_absolute() || !path.is_dir() { return Err("directory must be an existing absolute path".into()); }
    dunce::canonicalize(path).map_err(|_| "directory is unavailable".into())
}

fn executable_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if !path.is_absolute() || !path.is_file() { return Err("supply an existing absolute dsh executable path".into()); }
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if ["cmd", "bat", "ps1"].contains(&extension.as_str()) { return Err("unsupported: shell launchers; use a prepared native executable".into()); }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt;
      if path.metadata().map_err(|_| "executable unavailable")?.permissions().mode() & 0o111 == 0 { return Err("dsh path is not executable".into()); }
    }
    dunce::canonicalize(path).map_err(|_| "executable unavailable".into())
}

async fn check_version(executable: &Path, cwd: &Path, dsh_home: Option<&Path>) -> Result<String, String> {
    let mut child = child_command(executable, cwd, dsh_home).arg("--version")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "dsh version probe could not start")?;
    let mut stdout = child.stdout.take().ok_or("dsh version stdout missing")?;
    let result = tokio::time::timeout(RPC_TIMEOUT, async {
        let mut bytes = Vec::new();
        (&mut stdout).take(513).read_to_end(&mut bytes).await.map_err(|_| "dsh version read failed")?;
        if bytes.len() > 512 { return Err("dsh version output exceeds bound"); }
        let status = child.wait().await.map_err(|_| "dsh version probe wait failed")?;
        let version = std::str::from_utf8(&bytes).map_err(|_| "invalid dsh version output")?.trim();
        if !status.success() || version != PINNED_VERSION { return Err("unsupported: dsh executable version; require 0.2.0-rc.2"); }
        Ok(version.to_string())
    }).await.map_err(|_| "dsh version probe timed out".to_string())?;
    result.map_err(str::to_string)
}

#[derive(Default)]
pub struct DshAcpState {
    enabled: AtomicBool,
    lifecycle: Mutex<()>,
    client: Mutex<Option<Arc<Client>>>,
    last: Mutex<DshState>,
    generation: AtomicU64,
}

impl DshAcpState {
    fn require_enabled(&self) -> Result<(), String> {
        if !self.enabled.load(Ordering::Acquire) { return Err("dsh ACP experiment is disabled".into()); }
        Ok(())
    }

    async fn active(&self) -> Result<Arc<Client>, String> {
        self.require_enabled()?;
        self.client.lock().await.clone().ok_or("no owned dsh process".into())
    }

    pub async fn snapshot(&self) -> DshState {
        let client = self.client.lock().await.clone();
        let mut snapshot = match client { Some(client) => client.snapshot().await, None => self.last.lock().await.clone() };
        snapshot.enabled = self.enabled.load(Ordering::Acquire);
        snapshot
    }

    pub async fn set_enabled(&self, enabled: bool) -> DshState {
        let _lifecycle = self.lifecycle.lock().await;
        if !enabled { self.stop_inner().await; }
        self.enabled.store(enabled, Ordering::Release);
        self.snapshot().await
    }

    pub async fn start(&self, request: DshStartRequest) -> Result<DshState, String> {
        let _lifecycle = self.lifecycle.try_lock().map_err(|_| "dsh lifecycle operation already in progress")?;
        self.require_enabled()?;
        if self.client.lock().await.is_some() { return Err("an owned dsh process already exists; stop it explicitly first".into()); }
        let cwd = existing_directory(&request.cwd)?;
        let cwd_text = cwd.to_string_lossy().to_string();
        if let Some(saved) = &request.resume {
            opaque_id(saved.conv_id.as_deref().ok_or("missing saved dsh conversation ID")?)?;
            if saved.cwd != cwd_text { return Err("saved dsh cwd mismatch".into()); }
            if self.last.lock().await.run.as_ref().filter(|prior| prior.conv_id.is_some()).is_some_and(|prior| prior != saved) {
                return Err("stale saved dsh run reference".into());
            }
        }
        let executable = executable_path(&request.executable)?;
        let dsh_home = request.dsh_home.as_deref().filter(|s| !s.is_empty()).map(existing_directory).transpose()?;
        let version = check_version(&executable, &cwd, dsh_home.as_deref()).await?;
        let mut child = child_command(&executable, &cwd, dsh_home.as_deref()).arg("acp")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|_| "dsh ACP process could not start")?;
        let stdin = child.stdin.take().ok_or("dsh stdin missing")?;
        let stdout = child.stdout.take().ok_or("dsh stdout missing")?;
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                // Drain in fixed chunks; stderr may contain secrets and is never retained.
                let mut chunk = [0u8; 4096];
                while matches!(stderr.read(&mut chunk).await, Ok(n) if n > 0) {}
            });
        }
        let run = DshRunRef { run_id: uuid::Uuid::new_v4().to_string(),
            generation: self.generation.fetch_add(1, Ordering::Relaxed) + 1, conv_id: None, cwd: cwd_text };
        let client = Client::from_io(stdout, stdin, Some(child), run);
        if let Err(reason) = client.open(&version, request.resume.as_ref()).await {
            client.fail(&reason).await;
            client.stop().await;
            *self.last.lock().await = client.snapshot().await;
            return Err(reason);
        }
        *self.client.lock().await = Some(client.clone());
        Ok(client.snapshot().await)
    }

    pub async fn prompt(&self, request: DshPromptRequest) -> Result<DshDelivery, String> { self.active().await?.prompt(request).await }
    pub async fn cancel(&self, expected: &DshRunRef) -> Result<DshState, String> { self.active().await?.cancel(expected).await }
    pub async fn permission(&self, answer: DshPermissionAnswer) -> Result<DshState, String> { self.active().await?.answer(answer).await }
    pub async fn close_session(&self, expected: &DshRunRef) -> Result<DshState, String> { self.active().await?.close_session(expected).await }
    pub async fn read(&self, expected: &DshRunRef, cursor: u64) -> Result<DshRead, String> {
        let client = self.active().await?;
        let core = client.core.lock().await;
        if core.state.run.as_ref() != Some(expected) { return Err("stale dsh read reference".into()); }
        core.read(cursor)
    }

    async fn stop_inner(&self) {
        let client = self.client.lock().await.clone();
        if let Some(client) = client {
            client.stop().await;
            let snapshot = client.snapshot().await;
            // Retain ownership when wait cannot confirm exit. A failed cleanup
            // must not permit a replacement process alongside the previous one.
            if snapshot.process == "exited" { self.client.lock().await.take(); }
            *self.last.lock().await = snapshot;
        }
    }

    pub async fn stop_owned(&self, expected: Option<&DshRunRef>) -> Result<DshState, String> {
        let _lifecycle = self.lifecycle.lock().await;
        if let Some(expected) = expected {
            if self.snapshot().await.run.as_ref() != Some(expected) { return Err("stale dsh stop reference".into()); }
        }
        self.stop_inner().await;
        Ok(self.snapshot().await)
    }
}

#[tauri::command]
pub async fn dsh_acp_set_enabled(state: tauri::State<'_, DshAcpState>, enabled: bool) -> Result<DshState, String> {
    Ok(state.set_enabled(enabled).await)
}

#[tauri::command]
pub async fn dsh_acp_start(state: tauri::State<'_, DshAcpState>, request: DshStartRequest) -> Result<DshState, String> {
    state.start(request).await
}

#[tauri::command]
pub async fn dsh_acp_status(state: tauri::State<'_, DshAcpState>) -> Result<DshState, String> {
    Ok(state.snapshot().await)
}

#[tauri::command]
pub async fn dsh_acp_read(state: tauri::State<'_, DshAcpState>, expected_run: DshRunRef, cursor: u64) -> Result<DshRead, String> {
    state.read(&expected_run, cursor).await
}

#[tauri::command]
pub async fn dsh_acp_prompt(state: tauri::State<'_, DshAcpState>, request: DshPromptRequest) -> Result<DshDelivery, String> {
    state.prompt(request).await
}

#[tauri::command]
pub async fn dsh_acp_cancel(state: tauri::State<'_, DshAcpState>, expected_run: DshRunRef) -> Result<DshState, String> {
    state.cancel(&expected_run).await
}

#[tauri::command]
pub async fn dsh_acp_permission(state: tauri::State<'_, DshAcpState>, answer: DshPermissionAnswer) -> Result<DshState, String> {
    state.permission(answer).await
}

#[tauri::command]
pub async fn dsh_acp_close_session(state: tauri::State<'_, DshAcpState>, expected_run: DshRunRef) -> Result<DshState, String> {
    state.close_session(&expected_run).await
}

#[tauri::command]
pub async fn dsh_acp_stop_owned(state: tauri::State<'_, DshAcpState>, expected_run: Option<DshRunRef>) -> Result<DshState, String> {
    state.stop_owned(expected_run.as_ref()).await
}

#[cfg(test)]
mod tests;
