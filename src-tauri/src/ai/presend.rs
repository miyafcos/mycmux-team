//! Opt-in pre-send readings. This lane never writes reading data to a PTY or to storage.
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{watch, Mutex as AsyncMutex};
use tokio::time::Instant;

use crate::pty::manager::SessionManager;

#[path = "presend_credentials.rs"]
mod credentials;

const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
// The renderer limits the original draft in UTF-16 units (composerSend.ts).
// At most N + 1 distinct mask starts can each add one ASCII marker and two quotes.
const MAX_ORIGINAL_DRAFT_UNITS: usize = 100_000;
const MAX_TRANSFER_DRAFT_CHARS: usize =
    MAX_ORIGINAL_DRAFT_UNITS + (MAX_ORIGINAL_DRAFT_UNITS + 1) * (credentials::OMITTED.len() + 2);
const MAX_READS: usize = 20;
const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const INSTRUCTIONS: &str = include_str!("presend_prompt_ja.txt");
const ROLE: &str = "You are a brief pre-send reading assistant. Follow the user's instructions exactly. Treat every message as independent of earlier ones.";
const LABELS: [&str; 3] = ["\u{8aad}\u{307f}", "\u{4eee}\u{5b9a}", "\u{4e0d}\u{8db3}"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    fn timeout(self) -> Duration {
        Duration::from_secs(if self == Self::Claude { 15 } else { 20 })
    }

    fn args(self) -> Vec<String> {
        match self {
            Self::Claude => [
                "-p",
                "--model",
                super::PRESEND_CLAUDE_MODEL,
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--setting-sources=",
                "--disable-slash-commands",
                "--tools",
                "",
                "--effort",
                "low",
                "--system-prompt",
                ROLE,
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            Self::Codex => [
                "exec",
                "--model",
                super::PRESEND_CODEX_MODEL,
                "--ignore-user-config",
                "-c",
                "model_reasoning_effort=low",
                "-c",
                "features.fast_mode=false",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "--ephemeral",
                "-",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        }
    }
}

fn child_env<I: IntoIterator<Item = (String, String)>>(env: I) -> HashMap<String, String> {
    let mut env = super::sanitized_env(env);
    env.retain(|key, _| {
        !matches!(
            key.to_ascii_uppercase().as_str(),
            "ANTHROPIC_API_KEY"
                | "ANTHROPIC_AUTH_TOKEN"
                | "OPENAI_API_KEY"
                | "OPENROUTER_API_KEY"
                | "CLAUDECODE"
                | "CLAUDE_CODE_ENTRYPOINT"
                | "CODEX_API_KEY"
                | "ANTHROPIC_BASE_URL"
                | "CLAUDE_CODE_USE_BEDROCK"
                | "CLAUDE_CODE_USE_VERTEX"
        )
    });
    env
}

fn command<I: IntoIterator<Item = (String, String)>>(
    provider: Provider,
    env: I,
) -> Result<Command, ()> {
    let mut args = provider.args();
    let program = match provider {
        Provider::Claude => super::AiProvider::ClaudeCode.program(),
        Provider::Codex => super::AiProvider::Codex.program(),
    };
    let executable = crate::commands::terminal::prepare_spawn_command(program, &mut args);
    let cwd = crate::test_profile::runtime_dir()
        .map_err(|_| ())?
        .join("ai-cwd");
    Ok(command_inner(executable, &args, &cwd, env))
}

fn command_inner<I: IntoIterator<Item = (String, String)>>(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[String],
    cwd: &std::path::Path,
    env: I,
) -> Command {
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(child_env(env))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::util::process::CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut command = Command::from(command);
    command.kill_on_drop(true);
    command
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    reading: String,
    assumption: String,
    missing: String,
    elapsed_ms: u64,
    provider: Provider,
}

#[derive(serde::Serialize)]
#[serde(untagged)]
pub enum PresendResult {
    Complete(Reading),
    Incomplete { disposition: &'static str, attempted: bool },
}

#[derive(Default)]
struct ReadProgress {
    claim_revision: AtomicU64,
    attempted: AtomicBool,
}

fn remove_instruction_echo(value: &str) -> String {
    let mut result = value.to_string();
    for (open, close) in [('(', ')'), ('\u{ff08}', '\u{ff09}')] {
        let mut cursor = 0;
        while let Some(start) = result[cursor..].find(open).map(|at| at + cursor) {
            let Some(end) = result[start..].find(close).map(|at| at + start) else {
                break;
            };
            let inside: String = result[start + open.len_utf8()..end]
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            if inside
                .strip_suffix("\u{5b57}\u{4ee5}\u{5185}")
                .is_some_and(|number| {
                    !number.is_empty() && number.chars().all(|c| c.is_ascii_digit())
                })
            {
                result.replace_range(start..end + close.len_utf8(), "");
                cursor = start;
            } else {
                cursor = end + close.len_utf8();
            }
        }
    }
    result.trim().to_string()
}

fn parse_reading(text: &str, provider: Provider, elapsed_ms: u64) -> Option<Reading> {
    let lines: Vec<_> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.len() != 3 {
        return None;
    }
    let mut values = Vec::with_capacity(3);
    for (line, label) in lines.into_iter().zip(LABELS) {
        let body = line.trim().strip_prefix(label)?;
        let body = body
            .strip_prefix(':')
            .or_else(|| body.strip_prefix('\u{ff1a}'))?;
        let value = remove_instruction_echo(body);
        if value.is_empty() || value.chars().any(char::is_control) {
            return None;
        }
        values.push(value.chars().take(60).collect::<String>());
    }
    Some(Reading {
        reading: values.remove(0),
        assumption: values.remove(0),
        missing: values.remove(0),
        elapsed_ms,
        provider,
    })
}

enum Workdir<'a> {
    Path(&'a str),
    Basename(&'a str),
}

fn normalize_workdir_name(workdir: Workdir<'_>) -> String {
    let (value, raw_path) = match workdir {
        Workdir::Path(path) => (path, true),
        Workdir::Basename(name) => (name, false),
    };
    let safe_path = credentials::scrub(value);
    let path = match (raw_path, safe_path.as_bytes()) {
        (true, [b'A'..=b'Z' | b'a'..=b'z', b':', ..]) => &safe_path[2..],
        _ => safe_path.as_str(),
    };
    let name = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default();
    if name.contains(credentials::OMITTED) {
        return credentials::OMITTED.into();
    }
    name.into()
}

fn prompt(draft: &str, excerpt: &str, workdir: &str) -> String {
    let tail: String = excerpt
        .chars()
        .rev()
        .take(1500)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let previous = if tail.is_empty() {
        "(\u{306a}\u{3057}\u{3002}\u{3053}\u{306e}\u{5e2d}\u{306e}\u{6700}\u{521d}\u{306e}\u{4f9d}\u{983c})".to_string()
    } else {
        tail
    };
    #[derive(serde::Serialize)]
    struct State<'a> {
        #[serde(rename = "\u{76f4}\u{524d}\u{306e}\u{3084}\u{308a}\u{3068}\u{308a}")]
        previous: &'a str,
        #[serde(rename = "\u{66f8}\u{304d}\u{304b}\u{3051}\u{306e}\u{4f9d}\u{983c}")]
        draft: &'a str,
        #[serde(rename = "\u{4f5c}\u{696d}\u{30d5}\u{30a9}\u{30eb}\u{30c0}\u{540d}")]
        workdir: String,
    }
    let state = State {
        previous: &previous,
        draft,
        workdir: workdir.chars().take(240).collect(),
    };
    let mut bytes = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    serde::Serialize::serialize(&state, &mut serializer).expect("string state serialization");
    let json = String::from_utf8(bytes).expect("JSON is UTF-8");
    let instructions = INSTRUCTIONS.replace("\r\n", "\n");
    format!("{}\n\n\u{6b21}\u{304c}\u{4eca}\u{306e}\u{72b6}\u{614b}\u{3067}\u{3059} (JSON)\u{3002}\n\n{json}\n", instructions.trim_end())
}

type Operation<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
trait Session: Send {
    fn write<'a>(&'a mut self, prompt: &'a str) -> Operation<'a, Result<(), ()>>;
    fn read(&mut self) -> Operation<'_, Result<String, ()>>;
    fn close(&mut self) -> Operation<'_, ()>;
}
type Factory = Arc<dyn Fn(Provider) -> Result<Box<dyn Session>, ()> + Send + Sync>;

#[cfg(windows)]
type ProcessLease = std::os::windows::io::OwnedHandle;
#[cfg(not(windows))]
type ProcessLease = ();

fn process_lease(pid: u32) -> Result<ProcessLease, ()> {
    #[cfg(windows)]
    {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .map_err(|_| ())?;
        // This owned handle pins the process object until tree termination is
        // finished, so a reaped root's PID cannot be reused for another process.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle.0 as _) })
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Ok(())
    }
}

#[derive(Default)]
struct OwnedProcesses(Mutex<(bool, HashMap<u32, ProcessLease>)>);

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let killer = std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(crate::util::process::CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut killer) = killer {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                match killer.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) if std::time::Instant::now() >= deadline => {
                        let _ = killer.kill();
                        let _ = killer.wait();
                        break;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        }
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

impl OwnedProcesses {
    fn register(&self, pid: u32) -> Result<(), ()> {
        let lease = process_lease(pid)?;
        let mut owned = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if owned.0 {
            drop(owned);
            kill_tree(pid);
            return Err(());
        }
        owned.1.insert(pid, lease);
        Ok(())
    }
    fn kill(&self, pid: u32) {
        let owned = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .1
            .remove(&pid);
        if let Some(_lease) = owned {
            kill_tree(pid);
        }
    }
    fn shutdown(&self) {
        let pids: Vec<_> = {
            let mut owned = self.0.lock().unwrap_or_else(|e| e.into_inner());
            owned.0 = true;
            owned.1.drain().collect()
        };
        for (pid, _lease) in pids {
            kill_tree(pid);
        }
    }
}

struct ProcessSession {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    provider: Provider,
    pid: u32,
    owned: Arc<OwnedProcesses>,
}

async fn limited_line<R: tokio::io::AsyncBufRead + Unpin>(
    stdout: &mut R,
    remaining: &mut usize,
) -> Result<String, ()> {
    let mut line = Vec::new();
    loop {
        let buffer = stdout.fill_buf().await.map_err(|_| ())?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Err(())
            } else {
                Ok(String::from_utf8_lossy(&line).into_owned())
            };
        }
        let count = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |at| at + 1);
        if count > *remaining {
            return Err(());
        }
        let complete = buffer[count - 1] == b'\n';
        line.extend_from_slice(&buffer[..count]);
        *remaining -= count;
        stdout.consume(count);
        if complete {
            return Ok(String::from_utf8_lossy(&line).into_owned());
        }
    }
}
async fn read_claude_result<R: tokio::io::AsyncBufRead + Unpin>(
    stdout: &mut R,
) -> Result<String, ()> {
    // Reset for each request while preserving the reader's buffered next bytes.
    let mut remaining = MAX_OUTPUT_BYTES as usize;
    loop {
        let line = limited_line(stdout, &mut remaining).await?;
        let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(|value| value.as_str()) != Some("result") {
            continue;
        }
        if event
            .get("is_error")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            return Err(());
        }
        return event
            .get("result")
            .and_then(|value| value.as_str())
            .map(String::from)
            .ok_or(());
    }
}

impl ProcessSession {
    fn spawn(provider: Provider, owned: Arc<OwnedProcesses>) -> Result<Box<dyn Session>, ()> {
        let mut command = command(provider, std::env::vars())?;
        if let Some(cwd) = command.as_std().get_current_dir() {
            std::fs::create_dir_all(cwd).map_err(|_| ())?;
        }
        let mut child = command.spawn().map_err(|_| ())?;
        let pid = child.id().ok_or(())?;
        if owned.register(pid).is_err() {
            // The freshly spawned child still owns its original process
            // handle here, including when registration raced application exit.
            kill_tree(pid);
            return Err(());
        }
        let stdin = child.stdin.take();
        let stdout = match child.stdout.take() {
            Some(stdout) => BufReader::new(stdout),
            None => {
                owned.kill(pid);
                return Err(());
            }
        };
        Ok(Box::new(Self {
            child,
            stdin,
            stdout,
            provider,
            pid,
            owned,
        }))
    }
}

impl Session for ProcessSession {
    fn write<'a>(&'a mut self, prompt: &'a str) -> Operation<'a, Result<(), ()>> {
        Box::pin(async move {
            let stdin = self.stdin.as_mut().ok_or(())?;
            if self.provider == Provider::Claude {
                let mut line = serde_json::to_vec(&serde_json::json!({
                    "type": "user", "message": { "role": "user", "content": prompt }
                }))
                .map_err(|_| ())?;
                line.push(b'\n');
                stdin.write_all(&line).await.map_err(|_| ())?;
                stdin.flush().await.map_err(|_| ())?;
            } else {
                stdin.write_all(prompt.as_bytes()).await.map_err(|_| ())?;
                self.stdin.take();
            }
            Ok(())
        })
    }
    fn read(&mut self) -> Operation<'_, Result<String, ()>> {
        Box::pin(async move {
            if self.provider == Provider::Claude {
                read_claude_result(&mut self.stdout).await
            } else {
                let mut output = String::new();
                (&mut self.stdout)
                    .take(MAX_OUTPUT_BYTES + 1)
                    .read_to_string(&mut output)
                    .await
                    .map_err(|_| ())?;
                if output.len() > MAX_OUTPUT_BYTES as usize {
                    return Err(());
                }
                if !self.child.wait().await.map_err(|_| ())?.success() {
                    return Err(());
                }
                Ok(output)
            }
        })
    }
    fn close(&mut self) -> Operation<'_, ()> {
        Box::pin(async move {
            self.stdin.take();
            let owned = self.owned.clone();
            let pid = self.pid;
            let _ = tokio::task::spawn_blocking(move || owned.kill(pid)).await;
            let _ = self.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
        })
    }
}

impl Drop for ProcessSession {
    fn drop(&mut self) {
        self.owned.kill(self.pid);
        let _ = self.child.start_kill();
    }
}

#[derive(Clone, PartialEq, Eq)]
struct SourceConversation {
    kind: String,
    id: String,
    agent_pid: u32,
    started_at: u64,
}
impl From<crate::pty::manager::TrustedAgentIdentity> for SourceConversation {
    fn from(agent: crate::pty::manager::TrustedAgentIdentity) -> Self {
        Self { kind: agent.kind, id: agent.session_id, agent_pid: agent.agent_pid, started_at: agent.agent_started_at }
    }
}

#[derive(PartialEq, Eq)]
struct ReadingOwner {
    window: String,
    session_id: String,
    pty_generation: Option<u64>,
    conversation: Option<SourceConversation>,
}

#[derive(Default)]
struct Engine {
    session: Option<Box<dyn Session>>,
    provider: Option<Provider>,
    owner: Option<ReadingOwner>,
    reads: usize,
    last_used: Option<Instant>,
}
impl Engine {
    async fn close(&mut self) {
        if let Some(mut session) = self.session.take() {
            session.close().await;
        }
        self.provider = None;
        self.owner = None;
        self.reads = 0;
        self.last_used = None;
    }
    fn idle_at(&self, now: Instant, idle: Duration) -> bool {
        self.session.is_some()
            && self
                .last_used
                .is_some_and(|last| now.saturating_duration_since(last) >= idle)
    }
}

#[derive(Default)]
struct Control {
    enabled: bool,
    provider: Option<Provider>,
    revision: u64,
    generation: u64,
    last_claim_revision: u64,
    active: Option<String>,
    active_tab: Option<String>,
    paused_tabs: HashSet<String>,
    canceled: VecDeque<String>,
    shutdown: bool,
}
struct Inner {
    control: Mutex<Control>,
    updates: watch::Sender<u64>,
    engine: AsyncMutex<Engine>,
    factory: Factory,
    owned: Arc<OwnedProcesses>,
    idle: Duration,
    timeout: Option<Duration>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.owned.shutdown();
    }
}

#[derive(Clone)]
pub struct PresendService(Arc<Inner>);
impl Default for PresendService {
    fn default() -> Self {
        let owned = Arc::new(OwnedProcesses::default());
        let process_registry = owned.clone();
        Self::new(
            Arc::new(move |provider| ProcessSession::spawn(provider, process_registry.clone())),
            owned,
            IDLE_TIMEOUT,
            None,
        )
    }
}

impl PresendService {
    fn new(
        factory: Factory,
        owned: Arc<OwnedProcesses>,
        idle: Duration,
        timeout: Option<Duration>,
    ) -> Self {
        let (updates, _) = watch::channel(0);
        Self(Arc::new(Inner {
            control: Mutex::new(Control::default()),
            updates,
            engine: AsyncMutex::new(Engine::default()),
            factory,
            owned,
            idle,
            timeout,
        }))
    }
    fn current(&self, revision: u64) -> bool {
        let control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
        control.enabled && !control.shutdown && control.revision == revision
    }
    fn may_drain(&self, generation: u64, provider: Provider) -> bool {
        let control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
        control.enabled
            && !control.shutdown
            && control.provider == Some(provider)
            && control.generation == generation
    }
    pub async fn configure(&self, enabled: bool, provider: Provider) {
        let changed = {
            let mut control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
            if control.enabled == enabled && control.provider == Some(provider) {
                false
            } else {
                control.enabled = enabled && !control.shutdown;
                control.provider = Some(provider);
                control.active = None;
                control.active_tab = None;
                control.revision += 1;
                control.generation += 1;
                self.0.updates.send_replace(control.revision);
                true
            }
        };
        if changed {
            self.0.engine.lock().await.close().await;
        }
    }
    fn tab_preference(&self, session_id: &str, enabled: Option<bool>) -> bool {
        let mut control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
        if enabled == Some(true) {
            control.paused_tabs.remove(session_id);
        } else if enabled == Some(false) {
            control.paused_tabs.insert(session_id.to_owned());
            if control.active_tab.as_deref() == Some(session_id) {
                control.active = None;
                control.active_tab = None;
                control.revision += 1;
                self.0.updates.send_replace(control.revision);
            }
        }
        !control.paused_tabs.contains(session_id)
    }

    pub fn cancel(&self, request_id: &str) {
        let mut control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
        // Cancellation can cross an async IPC call before that call claims its
        // slot. Keep bounded tombstones so such a request never starts later.
        if !control.canceled.iter().any(|id| id == request_id) {
            control.canceled.push_back(request_id.to_string());
            if control.canceled.len() > 256 {
                control.canceled.pop_front();
            }
        }
        if control.active.as_deref() == Some(request_id) {
            control.active = None;
            control.active_tab = None;
            control.revision += 1;
            self.0.updates.send_replace(control.revision);
        }
    }
    pub fn shutdown(&self) {
        {
            let mut control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
            control.shutdown = true;
            control.generation += 1;
            control.enabled = false;
            control.active = None;
            control.active_tab = None;
            control.revision += 1;
            self.0.updates.send_replace(control.revision);
        }
        // Synchronous at RunEvent::Exit: do not rely on a runtime that is exiting.
        self.0.owned.shutdown();
    }
    fn arm_idle_timer(&self) {
        let weak = Arc::downgrade(&self.0);
        let idle = self.0.idle;
        tokio::spawn(async move {
            tokio::time::sleep(idle).await;
            if let Some(inner) = weak.upgrade() {
                PresendService(inner).expire_idle_at(Instant::now()).await;
            }
        });
    }
    async fn discard_unsent(&self, engine: &mut Engine, provider: Provider) {
        if provider == Provider::Codex {
            engine.close().await;
        } else if engine.session.is_some() {
            engine.last_used = Some(Instant::now());
            self.arm_idle_timer();
        }
    }
    async fn expire_idle_at(&self, now: Instant) {
        let mut engine = self.0.engine.lock().await;
        if engine.idle_at(now, self.0.idle) {
            engine.close().await;
        }
    }
    async fn read_renderer_request(
        &self,
        ai_enabled: bool,
        window: &str,
        request: PresendReadingRequest,
        observed_generation: Option<u64>,
        trusted_agent: impl Fn() -> Option<crate::pty::manager::TrustedAgentIdentity>,
        reply_is_current: impl FnOnce() -> bool,
        owner_is_current: impl Fn() -> bool,
        confirm_foreground: impl Future<Output = Option<bool>>,
        foreground_proof: Option<&Mutex<Option<LiveProcess>>>,
        progress: Option<&ReadProgress>,
    ) -> Option<Reading> {
        let PresendReadingRequest {
            request_id, session_id, pty_generation, provider, draft,
            conversation_excerpt, reply_source, workdir_name, workdir_is_basename, require_foreground_agent,
            edited_at_ms, conversation_at_edit,
        } = request;
        if pty_generation.is_some() && pty_generation != observed_generation
            || require_foreground_agent == Some(true) && (pty_generation.is_none() || edited_at_ms.unwrap_or(0) == 0)
        {
            return None;
        }
        let cached = trusted_agent().filter(|agent| {
            Some(agent.session_epoch) == pty_generation && agent.agent_pid > 0 && agent.agent_started_at > 0
        });
        let conversation = match conversation_at_edit {
            Some(edited) => Some(SourceConversation::from(cached.filter(|agent| edited.matches(agent))?)),
            None if foreground_proof.is_some() => None,
            None => cached.map(SourceConversation::from),
        };
        let source_is_current = || {
            owner_is_current() && conversation.as_ref().is_none_or(|expected| {
                let observed_process_matches = foreground_proof.is_none_or(|proof| {
                    proof.lock().unwrap_or_else(|error| error.into_inner()).is_some_and(|process| {
                        process.pid.as_u32() == expected.agent_pid && process.started_at == expected.started_at
                    })
                });
                observed_process_matches && trusted_agent().is_some_and(|agent| {
                    Some(agent.session_epoch) == pty_generation && SourceConversation::from(agent) == *expected
                })
            })
        };
        let confirmed_excerpt = || {
            let (Some(source), Some(_)) = (&reply_source, &conversation) else { return "" };
            if !reply_is_current() {
                return "";
            }
            trusted_agent()
                .filter(|agent| source.matches(pty_generation, agent))
                .map_or("", |_| conversation_excerpt.as_str())
        };
        self.read_request(
            ai_enabled,
            request_id,
            provider,
            ReadingOwner {
                window: window.to_owned(),
                session_id,
                pty_generation,
                conversation: conversation.clone(),
            },
            &draft,
            confirmed_excerpt,
            if workdir_is_basename {
                Workdir::Basename(&workdir_name)
            } else {
                Workdir::Path(&workdir_name)
            },
            source_is_current,
            async move { require_foreground_agent != Some(true) || confirm_foreground.await == Some(true) },
            progress,
        )
        .await
    }

    async fn read_request<'a>(
        &self,
        ai_enabled: bool,
        request_id: String,
        provider: Provider,
        owner: ReadingOwner,
        draft: &str,
        excerpt: impl FnOnce() -> &'a str,
        workdir: Workdir<'_>,
        owner_is_current: impl Fn() -> bool,
        confirm_foreground: impl Future<Output = bool>,
        progress: Option<&ReadProgress>,
    ) -> Option<Reading> {
        if !ai_enabled {
            self.configure(false, provider).await;
            return None;
        }
        if request_id.is_empty() || owner.session_id.is_empty() || draft.chars().nth(MAX_TRANSFER_DRAFT_CHARS).is_some() {
            return None;
        }
        let draft = credentials::scrub_for_reading(draft)?;
        let workdir = normalize_workdir_name(workdir);
        self.read(
            request_id,
            provider,
            owner,
            || {
                let excerpt = credentials::scrub_for_reading(excerpt())?;
                Some(prompt(&draft, &excerpt, &workdir))
            },
            owner_is_current,
            confirm_foreground,
            progress,
        )
        .await
    }
    async fn read(
        &self,
        request_id: String,
        provider: Provider,
        owner: ReadingOwner,
        build_prompt: impl FnOnce() -> Option<String>,
        owner_is_current: impl Fn() -> bool,
        confirm_foreground: impl Future<Output = bool>,
        progress: Option<&ReadProgress>,
    ) -> Option<Reading> {
        let (revision, generation, mut updates) = {
            let mut control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
            if !control.enabled
                || control.shutdown
                || control.provider != Some(provider)
                || control.canceled.contains(&request_id)
                || control.paused_tabs.contains(&owner.session_id)
            {
                return None;
            }
            control.revision += 1;
            control.active = Some(request_id);
            control.active_tab = Some(owner.session_id.clone());
            control.last_claim_revision = control.revision;
            if let Some(progress) = progress {
                progress.claim_revision.store(control.revision, Ordering::Relaxed);
            }
            self.0.updates.send_replace(control.revision);
            (
                control.revision,
                control.generation,
                self.0.updates.subscribe(),
            )
        };
        let mut engine = tokio::select! {
            biased;
            _ = updates.changed() => return None,
            engine = self.0.engine.lock() => engine,
        };
        if !self.current(revision) {
            return None;
        }
        let can_reuse_pty = owner.pty_generation.is_some() && owner.conversation.is_some();
        if engine.provider != Some(provider)
            || !can_reuse_pty
            || engine.owner.as_ref() != Some(&owner)
            || engine.idle_at(Instant::now(), self.0.idle)
        {
            engine.close().await;
        }
        let confirmed = tokio::select! {
            biased;
            _ = updates.changed() => return None,
            result = confirm_foreground => result,
        };
        if !confirmed || !self.current(revision) {
            return None;
        }
        let started = Instant::now();
        if engine.session.is_none() {
            engine.session = (self.0.factory)(provider).ok();
            engine.provider = Some(provider);
            engine.owner = Some(owner);
        }
        // Closing/spawning may have taken seconds. Never submit a superseded draft.
        if !self.current(revision) || !self.may_drain(generation, provider) {
            self.discard_unsent(&mut engine, provider).await;
            return None;
        }
        let Some(prompt) = build_prompt() else {
            self.discard_unsent(&mut engine, provider).await;
            return None;
        };
        if !owner_is_current() {
            engine.close().await;
            return None;
        }
        let deadline = started + self.0.timeout.unwrap_or(provider.timeout());
        let mut unsent = false;
        let output = if let Some(session) = engine.session.as_mut() {
            // Constructing a write future does not submit bytes; polling it does.
            let writing = session.write(&prompt);
            let mut began_writing = false;
            let sent = tokio::select! {
                biased;
                _ = updates.changed() => None,
                result = async {
                    began_writing = true;
                    if let Some(progress) = progress {
                        progress.attempted.store(true, Ordering::Relaxed);
                    }
                    tokio::time::timeout_at(deadline, writing).await
                } => Some(matches!(result, Ok(Ok(())))),
            };
            unsent = sent.is_none() && !began_writing;
            if sent == Some(true) {
                let mut reading = session.read();
                loop {
                    tokio::select! {
                        biased;
                        _ = updates.changed() => {
                            if provider == Provider::Codex || !self.may_drain(generation, provider) { break None; }
                            // Only a completely submitted Claude request needs draining.
                        },
                        result = tokio::time::timeout_at(deadline, &mut reading) => break result.ok().and_then(Result::ok),
                    }
                }
            } else {
                None
            }
        } else {
            None
        };
        if unsent {
            self.discard_unsent(&mut engine, provider).await;
            return None;
        }
        let result = output.filter(|_| owner_is_current()).and_then(|text| {
            parse_reading(
                &text,
                provider,
                started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            )
        });
        if result.is_none()
            || provider == Provider::Codex
            || !can_reuse_pty
            || !self.may_drain(generation, provider)
        {
            engine.close().await;
        } else {
            engine.reads += 1;
            engine.last_used = Some(Instant::now());
            if engine.reads >= MAX_READS {
                engine.close().await;
            }
        }
        let warm = engine.session.is_some();
        drop(engine);
        if warm {
            self.arm_idle_timer();
        }
        let owner_still_current = owner_is_current();
        let mut control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
        if control.revision != revision || !control.enabled || control.shutdown || !owner_still_current {
            return None;
        }
        control.active = None;
        control.active_tab = None;
        result
    }
}

pub fn lifecycle_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("presend-reading")
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                if let Some(service) = app.try_state::<PresendService>() {
                    service.shutdown();
                }
            }
        })
        .build()
}

#[tauri::command]
pub async fn configure_presend_reading(
    app: tauri::AppHandle,
    service: tauri::State<'_, PresendService>,
    enabled: Option<bool>,
    provider: Option<Provider>,
    session_id: Option<String>,
    tab_enabled: Option<bool>,
) -> Result<Option<bool>, String> {
    match (enabled, provider, session_id, tab_enabled) {
        (Some(enabled), Some(provider), None, None) => {
            service.configure(enabled && super::resolve(&app).enabled, provider).await;
            Ok(None)
        }
        (None, None, Some(session_id), tab_enabled) if !session_id.is_empty() => {
            Ok(Some(service.tab_preference(&session_id, tab_enabled)))
        }
        _ => Err("Invalid pre-send reading configuration".into()),
    }
}
#[tauri::command]
pub async fn cancel_presend_reading(
    service: tauri::State<'_, PresendService>,
    request_id: String,
) -> Result<(), String> {
    service.cancel(&request_id);
    Ok(())
}
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresendReplySource {
    pub(crate) pty_generation: u64,
    pub(crate) agent_kind: String,
    pub(crate) agent_session_id: String,
    pub(crate) occurred_at: u64,
    #[serde(default)]
    pub(crate) event_id: String,
    #[serde(default)]
    pub(crate) source_revision: u64,
    #[serde(default)]
    pub(crate) source_byte_start: u64,
    #[serde(default)]
    pub(crate) source_byte_end: u64,
    #[serde(default)]
    pub(crate) file_generation: u64,
    #[serde(default)]
    pub(crate) content_digest: String,
}
impl PresendReplySource {
    pub(crate) fn matches(&self, generation: Option<u64>, agent: &crate::pty::manager::TrustedAgentIdentity) -> bool {
        generation == Some(self.pty_generation)
            && agent.session_epoch == self.pty_generation
            && agent.kind == self.agent_kind
            && agent.session_id == self.agent_session_id
            // Reject transcript events from before or within the process birth second.
            && agent.agent_started_at > 0
            && self.occurred_at / 1_000 > agent.agent_started_at
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresendConversationAtEdit {
    agent_kind: String,
    agent_session_id: String,
}

impl PresendConversationAtEdit {
    fn matches(&self, agent: &crate::pty::manager::TrustedAgentIdentity) -> bool {
        self.agent_session_id == agent.session_id
            && (self.agent_kind == agent.kind
                || matches!((self.agent_kind.as_str(), agent.kind.as_str()),
                    ("claude", "claude-codex") | ("claude-codex", "claude")))
    }
}

#[cfg_attr(test, derive(serde::Deserialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
struct PresendReadingRequest {
    request_id: String,
    session_id: String,
    pty_generation: Option<u64>,
    provider: Provider,
    draft: String,
    conversation_excerpt: String,
    reply_source: Option<PresendReplySource>,
    workdir_name: String,
    #[cfg_attr(test, serde(default))]
    workdir_is_basename: bool,
    require_foreground_agent: Option<bool>,
    edited_at_ms: Option<u64>,
    conversation_at_edit: Option<PresendConversationAtEdit>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LiveProcess {
    pid: sysinfo::Pid,
    started_at: u64,
}

fn is_live_process(process: &sysinfo::Process) -> bool {
    use sysinfo::ProcessStatus::*;
    !matches!(process.status(), Zombie | Dead | Stop)
}

impl LiveProcess {
    fn predates_edit(self, edited_at_ms: u64) -> bool {
        // sysinfo reports birth in whole seconds. Require the whole second to
        // precede the edit so a replacement born in that second cannot inherit it.
        self.started_at.saturating_add(1).saturating_mul(1000) <= edited_at_ms
    }

    fn still_running(self) -> bool {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut system = System::new();
        system.refresh_processes_specifics(ProcessesToUpdate::Some(&[self.pid]), true, ProcessRefreshKind::nothing());
        system.process(self.pid).is_some_and(|p| p.start_time() == self.started_at && is_live_process(p))
    }
}

static PRESEND_PROBE: Mutex<()> = Mutex::new(());

#[cfg(test)]
fn foreground_agent_in_pty(root: u32) -> Option<Option<LiveProcess>> {
    foreground_agent_in_tree(root, &crate::commands::terminal::process_tree_for_roots(&[root]))
}

fn foreground_agent_in_tree(root: u32, system: &sysinfo::System) -> Option<Option<LiveProcess>> {
    use crate::pty::monitor::{build_child_index, find_agent_descendant};
    let root = sysinfo::Pid::from_u32(root);
    if !system.process(root).is_some_and(is_live_process) {
        return None;
    }
    let children = build_child_index(system);
    Some(find_agent_descendant(system, &children, root).and_then(|(_, pid)| {
        let process = system.process(pid)?;
        let started_at = process.start_time();
        (started_at > 0 && is_live_process(process)).then_some(LiveProcess { pid, started_at })
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ForegroundCheckFailure {
    StateUnavailable,
    PtyUnavailable,
    RootUnavailable,
    ProcessUnavailable,
    ProbeFailed,
    ProbeBusy,
    PtyExited,
    AgentChanged,
    Timeout,
    GenerationChanged,
}

fn foreground_check_line(result: Result<bool, ForegroundCheckFailure>, elapsed_ms: f64) -> Option<String> {
    use ForegroundCheckFailure::*;
    let result = match result {
        Ok(true) if elapsed_ms <= 150.0 => return None,
        Ok(true) => "slow_ok",
        Ok(false) => "no_agent",
        Err(StateUnavailable) => "state_unavailable",
        Err(PtyUnavailable) => "pty_unavailable",
        Err(RootUnavailable) => "root_unavailable",
        Err(ProcessUnavailable) => "process_unavailable",
        Err(ProbeFailed) => "probe_failed",
        Err(ProbeBusy) => "probe_busy",
        Err(PtyExited) => "pty_exited",
        Err(AgentChanged) => "agent_changed",
        Err(Timeout) => "timeout",
        Err(GenerationChanged) => "generation_changed",
    };
    Some(format!("presend_foreground_check result={result} elapsed_ms={elapsed_ms:.3}"))
}

fn finish_foreground_check(
    probe: Result<bool, ForegroundCheckFailure>, started: Instant, deadline: Instant, now: Instant,
) -> (Option<bool>, Option<String>) {
    let result = if now >= deadline { Err(ForegroundCheckFailure::Timeout) } else { probe };
    let line = foreground_check_line(result, now.saturating_duration_since(started).as_secs_f64() * 1_000.0);
    (result.ok(), line)
}

async fn confirm_foreground_agent<M: Send + Sync + 'static>(
    session: Option<(&Arc<M>, &str)>,
    observed_generation: Option<u64>,
    observe_root: fn(&M, &str) -> Option<(u64, u64, Option<u32>)>,
    observe_current: fn(&M, &str) -> Option<(u64, Option<u64>)>,
    is_running: fn(&M, &str) -> bool,
    detect: impl FnOnce(u32) -> Result<bool, ForegroundCheckFailure> + Send + 'static,
    timeout: Duration,
    write_diagnostic: impl FnOnce(&str) + Send + 'static,
) -> Option<bool> {
    use ForegroundCheckFailure::*;
    let started = Instant::now();
    let deadline = started + timeout;
    let runtime = tokio::runtime::Handle::try_current().ok()?;
    let result = async {
        let (manager, session_id) = session.ok_or(StateUnavailable)?;
        let manager = Arc::clone(manager);
        let session_id = session_id.to_owned();
        let probe = runtime.spawn_blocking(move || {
            let (epoch, _, root) = observe_root(&manager, &session_id).ok_or(PtyUnavailable)?;
            if Some(epoch) != observed_generation {
                return Err(GenerationChanged);
            }
            let foreground = detect(root.ok_or(RootUnavailable)?)?;
            let (current_epoch, _) = observe_current(&manager, &session_id).ok_or(PtyExited)?;
            if current_epoch != epoch {
                return Err(GenerationChanged);
            }
            is_running(&manager, &session_id).then_some(foreground).ok_or(PtyExited)
        });
        tokio::time::timeout_at(deadline, probe)
            .await
            .map_err(|_| Timeout)?
            .map_err(|_| ProbeFailed)?
    }
    .await;
    publish_foreground_check(result, started, deadline, Instant::now, |line| {
        let writer = runtime.clone();
        drop(runtime.spawn(async move {
            if let Ok(line) = line.await {
                drop(writer.spawn_blocking(move || write_diagnostic(&line)));
            }
        }));
    })
}

fn publish_foreground_check(
    probe: Result<bool, ForegroundCheckFailure>, started: Instant, deadline: Instant,
    clock: impl Fn() -> Instant,
    schedule: impl FnOnce(tokio::sync::oneshot::Receiver<String>),
) -> Option<bool> {
    let sampled = clock();
    if probe == Ok(true) && sampled < deadline && sampled.saturating_duration_since(started) <= Duration::from_millis(150) {
        return Some(true);
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    schedule(receive);
    let (result, line) = finish_foreground_check(probe, started, deadline, clock());
    if let Some(line) = line {
        let _ = send.send(line);
    }
    result
}

async fn read_presend_from_command(
    service: &PresendService,
    ai_enabled: impl FnOnce() -> bool,
    window: &str,
    mut request: PresendReadingRequest,
    manager: Option<&Arc<SessionManager>>,
    livebrief: Option<&crate::livebrief::LiveBriefService>,
    progress: Option<&ReadProgress>,
    write_diagnostic: impl FnOnce(&str) + Send + 'static,
) -> Option<Reading> {
    // The native command owns this requirement even if a renderer omits it.
    request.require_foreground_agent = Some(true);
    let session_id = request.session_id.clone();
    let reply_source = request.reply_source.clone();
    let edited_at_ms = request.edited_at_ms.filter(|at| *at > 0)?;
    let generation = request.pty_generation.filter(|generation| *generation > 0)?;
    let observe_generation = || manager?.session_observation(&session_id).map(|(epoch, _)| epoch);
    let started = Instant::now();
    let observed = manager.ok_or(ForegroundCheckFailure::StateUnavailable)
        .and_then(|manager| manager.session_observation(&session_id).ok_or(ForegroundCheckFailure::PtyUnavailable))
        .and_then(|(epoch, _)| (epoch == generation).then_some(epoch).ok_or(ForegroundCheckFailure::GenerationChanged));
    let observed_generation = match observed {
        Ok(epoch) => epoch,
        Err(reason) => {
            if let Some(line) = foreground_check_line(Err(reason), started.elapsed().as_secs_f64() * 1000.0) {
                drop(tokio::task::spawn_blocking(move || write_diagnostic(&line)));
            }
            return None;
        }
    };
    let proof = Arc::new(Mutex::new(None::<LiveProcess>));
    let probe_proof = Arc::clone(&proof);
    let reply_owner = Arc::new(AtomicBool::new(false));
    let probe_reply_owner = Arc::clone(&reply_owner);
    let ownership_scan = request.conversation_at_edit.as_ref().and(reply_source.clone())
        .and_then(|source| Some((Arc::clone(manager?), session_id.clone(), source)));
    service
        .read_renderer_request(
            ai_enabled(),
            window,
            request,
            Some(observed_generation),
            || manager?.trusted_agent_identity(&session_id),
            || reply_owner.load(Ordering::Relaxed)
                && livebrief.and_then(|service| service.presend_reply_source(&session_id)).as_ref() == reply_source.as_ref(),
            || observe_generation() == Some(observed_generation) && {
                let process = *proof.lock().unwrap_or_else(|err| err.into_inner());
                process.is_some_and(LiveProcess::still_running)
            },
            confirm_foreground_agent(
                manager.map(|manager| (manager, session_id.as_str())),
                Some(observed_generation),
                SessionManager::intervention_observation,
                SessionManager::session_observation,
                SessionManager::is_running,
                move |root| {
                    use ForegroundCheckFailure::*;
                    let _lease = match PRESEND_PROBE.try_lock() {
                        Ok(lease) => lease,
                        Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
                        Err(std::sync::TryLockError::WouldBlock) => return Err(ProbeBusy),
                    };
                    use crate::commands::terminal::{presend_owns_reply, process_tree_for_roots};
                    let ptys = ownership_scan.as_ref().map(|(manager, _, _)| manager.iter_pids());
                    let roots = ptys.as_ref().map_or_else(|| vec![root], |ptys| {
                        ptys.iter().filter_map(|(_, root)| *root).collect()
                    });
                    let tree = process_tree_for_roots(&roots);
                    let Some(process) = foreground_agent_in_tree(root, &tree).ok_or(ProcessUnavailable)? else {
                        return Ok(false);
                    };
                    if !process.predates_edit(edited_at_ms) {
                        return Err(AgentChanged);
                    }
                    if let (Some((manager, session, source)), Some(ptys)) = (ownership_scan, ptys) {
                        let owns = presend_owns_reply(&manager, &session, ptys, &tree, &source.agent_kind, &source.agent_session_id);
                        probe_reply_owner.store(owns, Ordering::Relaxed);
                    }
                    *probe_proof.lock().unwrap_or_else(|err| err.into_inner()) = Some(process);
                    Ok(true)
                },
                Duration::from_millis(250),
                write_diagnostic,
            ),
            Some(&proof),
            progress,
        )
        .await
}

#[tauri::command]
pub async fn run_presend_reading(
    window: tauri::Window,
    service: tauri::State<'_, PresendService>,
    request_id: String,
    session_id: String,
    pty_generation: Option<u64>,
    provider: Provider,
    draft: String,
    conversation_excerpt: String,
    reply_source: Option<PresendReplySource>,
    workdir_name: String,
    workdir_is_basename: Option<bool>,
    require_foreground_agent: Option<bool>,
    edited_at_ms: Option<u64>,
    conversation_at_edit: Option<PresendConversationAtEdit>,
) -> Result<Option<PresendResult>, String> {
    use tauri::Manager;

    let state = window.try_state::<crate::AppState>();
    let progress = ReadProgress::default();
    let result = read_presend_from_command(
        &service,
        || super::resolve(window.app_handle()).enabled,
        window.label(),
        PresendReadingRequest {
            request_id,
            session_id,
            pty_generation,
            provider,
            draft,
            conversation_excerpt,
            reply_source,
            workdir_name,
            workdir_is_basename: workdir_is_basename.unwrap_or_default(),
            require_foreground_agent,
            edited_at_ms,
            conversation_at_edit,
        },
        state.as_ref().map(|state| &state.session_manager),
        state.as_ref().map(|state| &state.livebrief_service),
        Some(&progress),
        crate::diag::log,
    ).await;
    if let Some(reading) = result {
        return Ok(Some(PresendResult::Complete(reading)));
    }
    let revision = progress.claim_revision.load(Ordering::Relaxed);
    let control = service.0.control.lock().unwrap_or_else(|e| e.into_inner());
    let superseded = revision != 0 && control.last_claim_revision > revision;
    let attempted = progress.attempted.load(Ordering::Relaxed);
    Ok((superseded || attempted).then_some(PresendResult::Incomplete {
        disposition: if superseded { "superseded" } else { "attempted" },
        attempted,
    }))
}

#[cfg(test)]
#[path = "presend_tests.rs"]
mod tests;
