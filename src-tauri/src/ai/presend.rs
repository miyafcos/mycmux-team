//! Opt-in pre-send readings. This lane never writes reading data to a PTY or to storage.
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
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

#[derive(PartialEq, Eq)]
struct ReadingOwner {
    window: String,
    session_id: String,
    pty_generation: Option<u64>,
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
    active: Option<String>,
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
        trusted_agent: impl FnOnce() -> Option<crate::pty::manager::TrustedAgentIdentity>,
        owner_is_current: impl FnOnce() -> bool,
        confirm_foreground: impl Future<Output = Option<bool>>,
    ) -> Option<Reading> {
        let PresendReadingRequest {
            request_id, session_id, pty_generation, provider, draft,
            conversation_excerpt, reply_source, workdir_name, workdir_is_basename, require_foreground_agent,
        } = request;
        if pty_generation.is_some() && pty_generation != observed_generation {
            return None;
        }
        let confirmed_excerpt = || {
            let Some(source) = &reply_source else { return "" };
            if pty_generation.is_none() {
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
            },
            &draft,
            confirmed_excerpt,
            if workdir_is_basename {
                Workdir::Basename(&workdir_name)
            } else {
                Workdir::Path(&workdir_name)
            },
            owner_is_current,
            async move { require_foreground_agent != Some(true) || confirm_foreground.await == Some(true) },
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
        owner_is_current: impl FnOnce() -> bool,
        confirm_foreground: impl Future<Output = bool>,
    ) -> Option<Reading> {
        if !ai_enabled {
            self.configure(false, provider).await;
            return None;
        }
        if request_id.is_empty() || owner.session_id.is_empty() || draft.chars().count() > 100_000 {
            return None;
        }
        let draft = credentials::scrub(draft);
        let workdir = normalize_workdir_name(workdir);
        self.read(
            request_id,
            provider,
            owner,
            || prompt(&draft, &credentials::scrub(excerpt()), &workdir),
            owner_is_current,
            confirm_foreground,
        )
        .await
    }
    async fn read(
        &self,
        request_id: String,
        provider: Provider,
        owner: ReadingOwner,
        build_prompt: impl FnOnce() -> String,
        owner_is_current: impl FnOnce() -> bool,
        confirm_foreground: impl Future<Output = bool>,
    ) -> Option<Reading> {
        let (revision, generation, mut updates) = {
            let mut control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
            if !control.enabled
                || control.shutdown
                || control.provider != Some(provider)
                || control.canceled.contains(&request_id)
            {
                return None;
            }
            control.revision += 1;
            control.active = Some(request_id);
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
        let can_reuse_pty = owner.pty_generation.is_some();
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
        let prompt = build_prompt();
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
        let result = output.and_then(|text| {
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
        let mut control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
        if control.revision != revision || !control.enabled || control.shutdown {
            return None;
        }
        control.active = None;
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
    enabled: bool,
    provider: Provider,
) -> Result<(), String> {
    service
        .configure(enabled && super::resolve(&app).enabled, provider)
        .await;
    Ok(())
}
#[tauri::command]
pub async fn cancel_presend_reading(
    service: tauri::State<'_, PresendService>,
    request_id: String,
) -> Result<(), String> {
    service.cancel(&request_id);
    Ok(())
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresendReplySource {
    pty_generation: u64,
    agent_kind: String,
    agent_session_id: String,
    occurred_at: u64,
}
impl PresendReplySource {
    fn matches(&self, generation: Option<u64>, agent: &crate::pty::manager::TrustedAgentIdentity) -> bool {
        generation == Some(self.pty_generation)
            && agent.session_epoch == self.pty_generation
            && agent.kind == self.agent_kind
            && agent.session_id == self.agent_session_id
            // Reject transcript events from before or within the process birth second.
            && agent.agent_started_at > 0
            && self.occurred_at / 1_000 > agent.agent_started_at
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
}

fn foreground_agent_in_pty(root: u32) -> Option<bool> {
    use crate::pty::monitor::{build_child_index, find_agent_descendant};
    use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, UpdateKind};

    let root = Pid::from_u32(root);
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    system.process(root)?;
    let children = build_child_index(&system);

    // Refresh command lines only in the PTY subtree for interpreter-based agents.
    let mut selected = std::collections::HashSet::new();
    let mut pending = vec![root];
    while let Some(pid) = pending.pop() {
        if selected.insert(pid) {
            pending.extend(children.get(&pid).into_iter().flatten().copied());
        }
    }
    let selected: Vec<_> = selected.into_iter().collect();
    system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&selected),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
    );
    let running = |pid| {
        system.process(pid).is_some_and(|process| {
            !matches!(process.status(), ProcessStatus::Zombie | ProcessStatus::Dead | ProcessStatus::Stop)
        })
    };
    if !running(root) {
        return None;
    }
    let children = build_child_index(&system);
    Some(find_agent_descendant(&system, &children, root).is_some_and(|(_, pid)| running(pid)))
}

#[derive(Clone, Copy)]
enum ForegroundCheckFailure {
    Unavailable,
    Timeout,
    GenerationChanged,
}

fn foreground_check_line(result: Result<bool, ForegroundCheckFailure>, elapsed_ms: f64) -> Option<String> {
    use ForegroundCheckFailure::*;
    let result = match result {
        Ok(true) if elapsed_ms <= 150.0 => return None,
        Ok(true) => "slow_ok",
        Ok(false) => "no_agent",
        Err(Unavailable) => "unavailable",
        Err(Timeout) => "timeout",
        Err(GenerationChanged) => "generation_changed",
    };
    Some(format!("presend_foreground_check result={result} elapsed_ms={elapsed_ms:.3}"))
}

async fn confirm_foreground_agent<M: Send + Sync + 'static>(
    session: Option<(&Arc<M>, &str)>,
    observed_generation: Option<u64>,
    observe_root: fn(&M, &str) -> Option<(u64, u64, Option<u32>)>,
    observe_current: fn(&M, &str) -> Option<(u64, Option<u64>)>,
    is_running: fn(&M, &str) -> bool,
    detect: impl FnOnce(u32) -> Option<bool> + Send + 'static,
    timeout: Duration,
    write_diagnostic: impl FnOnce(&str) + Send + 'static,
) -> Option<bool> {
    use ForegroundCheckFailure::*;
    let started = Instant::now();
    let deadline = started + timeout;
    let runtime = tokio::runtime::Handle::try_current().ok()?;
    let result = async {
        let (manager, session_id) = session.ok_or(Unavailable)?;
        let manager = Arc::clone(manager);
        let session_id = session_id.to_owned();
        let probe = runtime.spawn_blocking(move || {
            let (epoch, _, root) = observe_root(&manager, &session_id).ok_or(Unavailable)?;
            if Some(epoch) != observed_generation {
                return Err(GenerationChanged);
            }
            let foreground = detect(root.ok_or(Unavailable)?).ok_or(Unavailable)?;
            let (current_epoch, _) = observe_current(&manager, &session_id).ok_or(Unavailable)?;
            if current_epoch != epoch {
                return Err(GenerationChanged);
            }
            is_running(&manager, &session_id).then_some(foreground).ok_or(Unavailable)
        });
        let foreground = tokio::time::timeout_at(deadline, probe)
            .await
            .map_err(|_| Timeout)?
            .map_err(|_| Unavailable)??;
        (Instant::now() < deadline).then_some(foreground).ok_or(Timeout)
    }
    .await;
    if let Some(line) = foreground_check_line(result, started.elapsed().as_secs_f64() * 1_000.0) {
        drop(runtime.spawn_blocking(move || write_diagnostic(&line)));
    }
    // A positive probe must still be fresh after dispatching the diagnostic.
    result.ok().filter(|&foreground| !foreground || Instant::now() < deadline)
}

async fn read_presend_from_command(
    service: &PresendService,
    ai_enabled: impl FnOnce() -> bool,
    window: &str,
    request: PresendReadingRequest,
    manager: Option<&Arc<SessionManager>>,
) -> Option<Reading> {
    let session_id = request.session_id.clone();
    let observe_generation = || manager?.session_observation(&session_id).map(|(epoch, _)| epoch);
    let observed_generation = observe_generation();
    service
        .read_renderer_request(
            ai_enabled(),
            window,
            request,
            observed_generation,
            || manager?.trusted_agent_identity(&session_id),
            || observe_generation() == observed_generation,
            confirm_foreground_agent(
                manager.map(|manager| (manager, session_id.as_str())),
                observed_generation,
                SessionManager::intervention_observation,
                SessionManager::session_observation,
                SessionManager::is_running,
                foreground_agent_in_pty,
                Duration::from_millis(250),
                crate::diag::log,
            ),
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
) -> Result<Option<Reading>, String> {
    use tauri::Manager;

    let state = window.try_state::<crate::AppState>();
    Ok(read_presend_from_command(
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
        },
        state.as_ref().map(|state| &state.session_manager),
    )
    .await)
}

#[cfg(test)]
#[path = "presend_tests.rs"]
mod tests;
