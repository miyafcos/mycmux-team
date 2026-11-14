//! A private, bounded setup-token PTY. Its output never enters the terminal manager.
use std::{
    io::{Read, Write}, path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, SyncSender}, Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use super::{claude::ClaudePaths, launch_tokens::{self, LaunchTokenStatus, LaunchTokenStore, SaveOutcome},
    staging, token_owner::LaunchOwnerCheck, ERR_LAUNCH_TOKEN_OWNER_MISMATCH};

const OUTPUT_LIMIT: usize = 1024 * 1024;
pub(super) const AUTH_ENV_KEYS: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
];
// Claude Code 2.1.323 setup-token: terminal error view and revoked-token gate.
// Match known screen lines, never generic words in startup notices.
const ERROR_MARKERS: &[&str] = &[
    "OAuth error:", "Press Enter to retry.",
    "Anthropic reported the token revoked; it was not shown.",
];
const UNAVAILABLE: &str = "cli_account.error.setup_unavailable";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupTokenState {
    Starting, WaitingBrowser, CodeAvailable, CheckingOwner, Saved, Mismatch, Failed, Cancelled, Timeout,
}
impl SetupTokenState {
    fn terminal(&self) -> bool {
        matches!(self, Self::Saved | Self::Mismatch | Self::Failed | Self::Cancelled | Self::Timeout)
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct SetupTokenEvent {
    pub login_id: String,
    pub profile_id: String,
    pub state: SetupTokenState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<LaunchTokenStatus>,
}
struct Attempt {
    event: SetupTokenEvent,
    cancel: Arc<AtomicBool>,
    codes: SyncSender<SecretBytes>,
    active: bool,
    accepting_cancel: bool,
    code_submitted: bool,
    accepting_code: bool,
}
pub struct SetupControl {
    cancelled: Arc<AtomicBool>,
    codes: Receiver<SecretBytes>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupShutdown { Idle, Finished, TimedOut }
#[derive(Default)]
pub struct SetupTokenRegistry {
    inner: Mutex<Option<Attempt>>,
    shutting_down: AtomicBool,
    idle: Condvar,
    #[cfg(test)]
    wait_entries: AtomicUsize,
}
impl SetupTokenRegistry {
    pub fn begin(&self, profile_id: &str) -> Result<(SetupTokenEvent, SetupControl), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if self.shutting_down.load(Ordering::SeqCst) || inner.as_ref().is_some_and(|attempt| attempt.active) {
            return Err("cli_account.error.setup_already_running".into());
        }
        let event = SetupTokenEvent { login_id: uuid::Uuid::new_v4().simple().to_string(),
            profile_id: profile_id.into(), state: SetupTokenState::Starting, url: None, reason: None, status: None };
        let cancelled = Arc::new(AtomicBool::new(false));
        let (codes, receiver) = mpsc::sync_channel(1);
        *inner = Some(Attempt { event: event.clone(), cancel: cancelled.clone(), codes,
            active: true, accepting_cancel: true, code_submitted: false, accepting_code: true });
        Ok((event, SetupControl { cancelled, codes: receiver }))
    }
    pub fn close_for_exit(&self) {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(attempt) = inner.as_ref().filter(|attempt| attempt.active && attempt.accepting_cancel) {
            attempt.cancel.store(true, Ordering::SeqCst);
        }
    }
    pub fn wait_idle(&self, deadline: Instant) -> SetupShutdown {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if !inner.as_ref().is_some_and(|attempt| attempt.active) { return SetupShutdown::Idle; }
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return SetupShutdown::TimedOut;
            };
            // Tests observe that the waiter holds the lock and is about to wait.
            #[cfg(test)] self.wait_entries.fetch_add(1, Ordering::SeqCst);
            inner = self.idle.wait_timeout(inner, remaining).unwrap_or_else(|error| error.into_inner()).0;
            if !inner.as_ref().is_some_and(|attempt| attempt.active) { return SetupShutdown::Finished; }
        }
    }
    pub fn current(&self) -> Result<Option<SetupTokenEvent>, String> {
        Ok(self.inner.lock().unwrap_or_else(|error| error.into_inner()).as_ref().map(|attempt| attempt.event.clone()))
    }
    pub fn cancel(&self, login_id: &str) -> Result<(), String> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt = inner.as_ref().filter(|attempt| attempt.active && attempt.accepting_cancel && attempt.event.login_id == login_id)
            .ok_or_else(|| UNAVAILABLE.to_string())?;
        attempt.cancel.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub fn submit_code(&self, login_id: &str, code: String) -> Result<(), String> {
        let code = SecretBytes(code.into_bytes());
        let valid = code.0.len() <= 4096 && code.0.iter().all(u8::is_ascii_graphic)
            && code.0.iter().position(|byte| *byte == b'#').is_some_and(|at| at > 0 && at + 1 < code.0.len());
        if !valid { return Err("cli_account.error.setup_invalid_code".into()); }
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt = inner.as_mut().filter(|attempt| attempt.active && attempt.accepting_code && !attempt.code_submitted
            && !attempt.cancel.load(Ordering::SeqCst) && attempt.event.login_id == login_id
            && attempt.event.state == SetupTokenState::CodeAvailable).ok_or_else(|| UNAVAILABLE.to_string())?;
        attempt.codes.try_send(code).map_err(|_| UNAVAILABLE.to_string())?;
        attempt.code_submitted = true;
        Ok(())
    }
    pub(super) fn publish(&self, login_id: &str, state: SetupTokenState, url: Option<String>,
        reason: Option<String>, status: Option<LaunchTokenStatus>) -> Option<SetupTokenEvent> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt = inner.as_mut().filter(|attempt| attempt.event.login_id == login_id && attempt.active)?;
        if let Some(url) = url { attempt.event.url = Some(url); }
        attempt.event.state = state;
        attempt.event.reason = reason;
        attempt.event.status = status;
        if attempt.event.state.terminal() {
            attempt.active = false;
            attempt.accepting_cancel = false;
            attempt.accepting_code = false;
            // Approval URLs are only useful during the current authorization.
            attempt.event.url = None;
            // AttemptGuard publishes only after its PTY and staging are cleaned.
            self.idle.notify_all();
        }
        Some(attempt.event.clone())
    }
    fn close_input(&self, login_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(attempt) = inner.as_mut().filter(|attempt| attempt.event.login_id == login_id) {
            attempt.accepting_code = false;
        }
    }
    fn commit(&self, login_id: &str, save: impl FnOnce() -> Result<SaveOutcome, String>) -> Result<SaveOutcome, String> {
        {
            // Decide the cancellation boundary under the lock, then release it
            // before file/OS-store I/O or any caller-supplied code can panic.
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let attempt = inner.as_mut().filter(|attempt| attempt.active && attempt.event.login_id == login_id)
                .ok_or_else(|| UNAVAILABLE.to_string())?;
            if attempt.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
            attempt.accepting_cancel = false;
        }
        save()
    }
}
pub(super) struct SecretBytes(Vec<u8>);
impl SecretBytes {
    fn as_slice(&self) -> &[u8] { &self.0 }
    fn wipe(&mut self) {
        for byte in &mut self.0 {
            // Keep the overwrite even when the allocation is about to be released.
            unsafe { std::ptr::write_volatile(byte, 0); }
        }
        std::sync::atomic::compiler_fence(Ordering::SeqCst);
    }
}
impl Drop for SecretBytes { fn drop(&mut self) { self.wipe(); } }

pub fn scrub_setup_env(command: &mut CommandBuilder) {
    let names: Vec<_> = command.iter_full_env_as_str().filter(|(name, _)| {
        AUTH_ENV_KEYS.iter().any(|key| name.eq_ignore_ascii_case(key))
            || name.to_ascii_uppercase().starts_with("MYCMUX_")
            || name.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR")
    }).map(|(name, _)| name.to_string()).collect();
    for name in names { command.env_remove(name); }
}
pub fn native_command(login_path: Option<&str>) -> CommandBuilder {
    let mut args = vec!["setup-token".to_string()];
    // Keep the existing Windows PATH/PATHEXT resolver and cmd/bat wrapper.
    let executable = crate::commands::terminal::prepare_spawn_command("claude", &mut args);
    #[cfg(target_os = "macos")]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        login_path.and_then(|path| std::env::split_paths(path).map(|dir| dir.join("claude"))
            .find(|candidate| candidate.metadata().is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)))
            .map(|path| path.into_os_string()).unwrap_or_else(|| executable.into())
    };
    let mut command = CommandBuilder::new(executable);
    command.args(args);
    scrub_setup_env(&mut command);
    if let Some(path) = login_path { command.env("PATH", path); }
    command
}
pub(super) fn strip_controls(raw: &[u8]) -> SecretBytes {
    let mut plain = Vec::with_capacity(raw.len());
    let mut at = 0;
    while at < raw.len() {
        match raw[at] {
            0x1b => {
                at += 1;
                if at >= raw.len() { break; }
                match raw[at] {
                    b'[' => {
                        at += 1;
                        while at < raw.len() && !(0x40..=0x7e).contains(&raw[at]) { at += 1; }
                        // An unfinished CSI and a trailing erase do not complete
                        // the preceding text line. Cursor motion still separates rows.
                        if at >= raw.len() || (raw[at] == b'K' && at + 1 == raw.len()) { break; }
                        if raw[at] != b'm' { plain.push(b'\n'); }
                        at = (at + 1).min(raw.len());
                    }
                    b']' | b'P' | b'_' | b'^' => {
                        at += 1;
                        while at < raw.len() {
                            if raw[at] == 7 { at += 1; break; }
                            if raw[at] == 0x1b && raw.get(at + 1) == Some(&b'\\') { at += 2; break; }
                            at += 1;
                        }
                    }
                    _ => {
                        while at < raw.len() && (0x20..=0x2f).contains(&raw[at]) { at += 1; }
                        at = (at + 1).min(raw.len());
                    }
                }
            }
            b'\r' => {
                if raw.get(at + 1) != Some(&b'\n') { plain.push(b'\n'); }
                at += 1;
            }
            b'\n' | b'\t' => { plain.push(raw[at]); at += 1; }
            0..=31 | 127 => { plain.push(b'\n'); at += 1; }
            _ => { plain.push(raw[at]); at += 1; }
        }
    }
    SecretBytes(plain)
}
fn valid_token(value: &str) -> bool {
    value.strip_prefix("sk-ant-oat").is_some_and(|rest| {
        let b = rest.as_bytes();
        (23..=515).contains(&b.len()) && b[0].is_ascii_digit() && b[1].is_ascii_digit()
            && b[2] == b'-' && b[3..].iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    })
}
pub(super) fn extract_token(plain: &[u8]) -> Option<SecretBytes> {
    let mut marker = false;
    let mut candidate: Option<&str> = None;
    let mut previous_candidate = false;
    for bytes in plain.split_inclusive(|byte| *byte == b'\n') {
        if bytes.last() != Some(&b'\n') { break; } // Never accept a partial token line.
        let Ok(line) = std::str::from_utf8(bytes) else { continue; };
        let line = line.trim();
        if line.contains("OAuth token") { marker = true; continue; }
        if line.contains("sk-ant-oat") {
            if !marker || !valid_token(line) || candidate.is_some_and(|value| value != line) { return None; }
            candidate = Some(line);
            previous_candidate = true;
        } else {
            // A wrapped continuation must not turn a valid-looking prefix into a saved token.
            if previous_candidate && !line.is_empty()
                && line.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')) { return None; }
            if !line.is_empty() { previous_candidate = false; }
        }
    }
    candidate.map(|value| SecretBytes(value.as_bytes().to_vec()))
}
pub(super) fn authorization_url(plain: &[u8]) -> Option<String> {
    plain.split(|byte| *byte == b'\n').filter_map(|line| std::str::from_utf8(line).ok())
        .flat_map(str::split_whitespace).find(|word| word.starts_with("https://") && word.contains("/oauth/authorize?") && word.len() <= 8192
            && !word.contains("sk-ant-oat") && word.bytes().all(|byte| !byte.is_ascii_control()))
        .map(str::to_owned)
}
fn cli_error(plain: &[u8]) -> bool {
    plain.split(|byte| *byte == b'\n').filter_map(|line| std::str::from_utf8(line).ok()).any(|line| {
        let line = line.trim();
        if line.contains("https://") || line.contains("sk-ant-oat") { return false; }
        ERROR_MARKERS.iter().any(|marker| {
            if *marker == "OAuth error:" { line.starts_with(marker) }
            else if *marker == "Press Enter to retry." { line.trim_end_matches('.') == marker.trim_end_matches('.') }
            else { line.ends_with(marker) }
        })
    })
}
pub struct RunOptions {
    pub timeout: Duration,
    pub token_exit_grace: Duration,
    pub fallback_after: Duration,
}
impl Default for RunOptions {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(600), token_exit_grace: Duration::from_secs(5),
            fallback_after: Duration::from_secs(3) }
    }
}
pub struct RunAudit { pub child_stopped: bool, pub wiped_buffer: Vec<u8> }
struct StagingGuard<F: Fn(&Path)> { path: PathBuf, cleanup: F }
impl<F: Fn(&Path)> Drop for StagingGuard<F> { fn drop(&mut self) { (self.cleanup)(&self.path); } }
struct PrivatePty {
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    _master: Box<dyn MasterPty + Send>,
    stopped: bool,
}
impl PrivatePty {
    fn stop(&mut self) -> bool {
        if self.stopped { return true; }
        // portable-pty starts Unix children as session/process-group leaders.
        // Descendants may otherwise keep the private PTY reader open forever.
        #[cfg(unix)]
        if let Some(pid) = self.child.process_id().filter(|pid| *pid > 1 && *pid <= i32::MAX as u32) {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
        }
        if self.child.try_wait().ok().flatten().is_none() { let _ = self.child.kill(); }
        self.stopped = self.child.wait().is_ok();
        self.stopped
    }
}
impl Drop for PrivatePty { fn drop(&mut self) { self.stop(); } }

struct AttemptGuard<'a, E: FnMut(SetupTokenEvent)> {
    registry: &'a SetupTokenRegistry,
    id: &'a str,
    emit: E,
}
impl<E: FnMut(SetupTokenEvent)> AttemptGuard<'_, E> {
    fn publish(&mut self, state: SetupTokenState, url: Option<String>, reason: Option<&str>, status: Option<LaunchTokenStatus>) {
        if let Some(event) = self.registry.publish(self.id, state, url, reason.map(str::to_string), status) { (self.emit)(event); }
    }
}
impl<E: FnMut(SetupTokenEvent)> Drop for AttemptGuard<'_, E> {
    fn drop(&mut self) {
        // A panic must release the single-attempt gate even if a mutex was
        // poisoned. Never let an event sink cause a second unwind in Drop.
        if let Some(event) = self.registry.publish(self.id, SetupTokenState::Failed, None, Some("save_failed".into()), None) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.emit)(event)));
        }
    }
}
fn drain_output(receiver: &Receiver<SecretBytes>, raw: &mut SecretBytes, timeout: Duration) -> Result<(), &'static str> {
    let deadline = Instant::now() + timeout;
    let mut failure = None;
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err(failure.unwrap_or("capture_failed"));
        };
        match receiver.recv_timeout(remaining) {
            Ok(chunk) => {
                if raw.0.len() + chunk.0.len() > OUTPUT_LIMIT { failure = Some("output_limit"); }
                else { raw.0.extend_from_slice(chunk.as_slice()); }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return failure.map_or(Ok(()), Err),
            Err(mpsc::RecvTimeoutError::Timeout) => return Err(failure.unwrap_or("capture_failed")),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn run_attempt(
    registry: &SetupTokenRegistry, initial: SetupTokenEvent, control: SetupControl,
    base: &Path, live: &ClaudePaths, command: CommandBuilder, options: RunOptions,
    secrets: &dyn LaunchTokenStore, check_owner: impl FnOnce(&str) -> LaunchOwnerCheck,
    cleanup_staging: impl Fn(&Path), emit: impl FnMut(SetupTokenEvent),
) -> RunAudit {
    run_attempt_with_close(registry, initial, control, base, live, command, options, secrets, check_owner, cleanup_staging, emit, drop)
}

#[allow(clippy::too_many_arguments)]
fn run_attempt_with_close(
    registry: &SetupTokenRegistry, initial: SetupTokenEvent, control: SetupControl,
    base: &Path, live: &ClaudePaths, mut command: CommandBuilder, options: RunOptions,
    secrets: &dyn LaunchTokenStore, check_owner: impl FnOnce(&str) -> LaunchOwnerCheck,
    cleanup_staging: impl Fn(&Path), emit: impl FnMut(SetupTokenEvent),
    close_pty: impl FnOnce(PrivatePty) + Send + 'static,
) -> RunAudit {
    let id = &initial.login_id;
    let mut guard = AttemptGuard { registry, id, emit };
    let mut raw = SecretBytes(Vec::with_capacity(OUTPUT_LIMIT));
    let staging = match staging::create_staging_dir(base) {
        Ok(path) => StagingGuard { path, cleanup: cleanup_staging },
        Err(_) => {
            guard.publish(SetupTokenState::Failed, None, Some("launch_failed"), None);
            return RunAudit { child_stopped: true, wiped_buffer: vec![] };
        }
    };
    if control.cancelled.load(Ordering::SeqCst) {
        drop(staging);
        guard.publish(SetupTokenState::Cancelled, None, Some("cancelled"), None);
        return RunAudit { child_stopped: true, wiped_buffer: vec![] };
    }
    staging::seed_claude_staging(&staging.path, live);
    scrub_setup_env(&mut command);
    command.env("CLAUDE_CONFIG_DIR", &staging.path);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.cwd(&staging.path);
    let spawn = || -> Result<_, ()> {
        let pair = native_pty_system().openpty(PtySize { cols: 512, rows: 40, pixel_width: 0, pixel_height: 0 }).map_err(|_| ())?;
        let reader = pair.master.try_clone_reader().map_err(|_| ())?;
        let writer = pair.master.take_writer().map_err(|_| ())?;
        if control.cancelled.load(Ordering::SeqCst) { return Err(()); }
        let child = pair.slave.spawn_command(command).map_err(|_| ())?;
        drop(pair.slave);
        Ok((PrivatePty { child, writer, _master: pair.master, stopped: false }, reader))
    };
    let (mut pty, mut reader) = match spawn() {
        Ok(pair) => pair,
        Err(_) => {
            drop(staging);
            if control.cancelled.load(Ordering::SeqCst) {
                guard.publish(SetupTokenState::Cancelled, None, Some("cancelled"), None);
            } else {
                guard.publish(SetupTokenState::Failed, None, Some("launch_failed"), None);
            }
            return RunAudit { child_stopped: true, wiped_buffer: vec![] };
        }
    };
    let (sender, receiver) = mpsc::sync_channel(8);
    let reader_thread = std::thread::spawn(move || {
        loop {
            let mut chunk = SecretBytes(vec![0; 8192]);
            match reader.read(&mut chunk.0) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    // Wipe the unused tail before shortening the allocation.
                    for byte in &mut chunk.0[count..] { unsafe { std::ptr::write_volatile(byte, 0); } }
                    chunk.0.truncate(count);
                    if sender.send(chunk).is_err() { break; }
                }
            }
        }
    });
    guard.publish(SetupTokenState::WaitingBrowser, None, None, None);
    let started = Instant::now();
    let mut candidate_since = None;
    let mut fallback_shown = false;
    let mut last_url = None;
    let mut failure = None;
    let mut parsed_len = 0;
    let mut captured = None;
    loop {
        if control.cancelled.load(Ordering::SeqCst) { failure = Some((SetupTokenState::Cancelled, "cancelled")); break; }
        if started.elapsed() >= options.timeout { failure = Some((SetupTokenState::Timeout, "timeout")); break; }
        if let Ok(mut code) = control.codes.try_recv() {
            let sent = pty.writer.write_all(code.as_slice()).and_then(|_| pty.writer.flush());
            code.wipe();
            if sent.is_err() { failure = Some((SetupTokenState::Failed, "cli_error")); break; }
            std::thread::sleep(Duration::from_millis(150));
            if control.cancelled.load(Ordering::SeqCst) { failure = Some((SetupTokenState::Cancelled, "cancelled")); break; }
            if pty.writer.write_all(b"\r").and_then(|_| pty.writer.flush()).is_err() {
                failure = Some((SetupTokenState::Failed, "cli_error")); break;
            }
        }
        let mut eof = false;
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => {
                if raw.0.len() + chunk.0.len() > OUTPUT_LIMIT {
                    failure = Some((SetupTokenState::Failed, "output_limit")); break;
                }
                raw.0.extend_from_slice(chunk.as_slice());
                // Consume already queued output together before scanning it.
                while let Ok(chunk) = receiver.try_recv() {
                    if raw.0.len() + chunk.0.len() > OUTPUT_LIMIT {
                        failure = Some((SetupTokenState::Failed, "output_limit")); break;
                    }
                    raw.0.extend_from_slice(chunk.as_slice());
                }
                if failure.is_some() { break; }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => eof = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if raw.0.len() != parsed_len {
            parsed_len = raw.0.len();
            let plain = strip_controls(raw.as_slice());
            if cli_error(plain.as_slice()) { failure = Some((SetupTokenState::Failed, "cli_error")); break; }
            if let Some(url) = authorization_url(plain.as_slice()) {
                if last_url.as_ref() != Some(&url) {
                    last_url = Some(url);
                    guard.publish(if fallback_shown { SetupTokenState::CodeAvailable } else { SetupTokenState::WaitingBrowser }, last_url.clone(), None, None);
                }
            }
            captured = extract_token(plain.as_slice());
            if captured.is_some() && candidate_since.is_none() { candidate_since = Some(Instant::now()); }
        }
        if started.elapsed() >= options.fallback_after && !fallback_shown {
            fallback_shown = true;
            guard.publish(SetupTokenState::CodeAvailable, last_url.clone(), None, None);
        }
        // Finish the current output before accepting its uniqueness. This also
        // catches candidates split between reads. A CLI left open is bounded.
        if eof || pty.child.try_wait().ok().flatten().is_some()
            || candidate_since.is_some_and(|at| at.elapsed() >= options.token_exit_grace) { break; }
    }
    registry.close_input(id);
    if failure.is_none() && pty.child.try_wait().ok().flatten().is_some_and(|status| !status.success()) {
        failure = Some((SetupTokenState::Failed, "cli_error"));
    }
    let stopped = pty.stop();
    // The writer/master are never registered with any terminal or control API.
    // ClosePseudoConsole may wait for the reader; keep draining on this thread.
    let _ = std::thread::spawn(move || close_pty(pty));
    // A detached descendant can retain its handle even after the process group
    // is killed. Bound draining and never join a still-blocked reader thread.
    if let Err(reason) = drain_output(&receiver, &mut raw, Duration::from_secs(2)) {
        if failure.is_none() { failure = Some((SetupTokenState::Failed, reason)); }
    }
    drop(receiver); // Dropping queued chunks also wipes their allocations.
    if reader_thread.is_finished() { let _ = reader_thread.join(); }
    if raw.0.len() != parsed_len {
        let plain = strip_controls(raw.as_slice());
        if failure.is_none() && cli_error(plain.as_slice()) { failure = Some((SetupTokenState::Failed, "cli_error")); }
        captured = extract_token(plain.as_slice());
    }
    if failure.is_some() { captured = None; }
    raw.wipe();
    let (state, reason, status) = if let Some((state, reason)) = failure {
        (state, Some(reason), None)
    } else if let Some(mut token) = captured {
        guard.publish(SetupTokenState::CheckingOwner, None, None, None);
        let result = if control.cancelled.load(Ordering::SeqCst) { Err("cancelled".to_string()) } else {
            // Use the same owner lookup as manual registration; inspect
            // cancellation after network lookup, before any local write.
            let value = std::str::from_utf8(token.as_slice()).expect("validated ASCII");
            let checked = check_owner(value);
            registry.commit(id, || launch_tokens::save_with_outcome(base, secrets, &initial.profile_id, value, |_| checked))
        };
        token.wipe();
        match result {
            Ok(SaveOutcome::Saved(status)) => (SetupTokenState::Saved, None, Some(status)),
            Ok(SaveOutcome::MismatchRecorded(status)) => (SetupTokenState::Mismatch, Some("owner_mismatch"), Some(status)),
            Err(error) if error == "cancelled" => (SetupTokenState::Cancelled, Some("cancelled"), None),
            Err(error) if error == ERR_LAUNCH_TOKEN_OWNER_MISMATCH => (SetupTokenState::Mismatch, Some("owner_mismatch"), None),
            Err(_) => (SetupTokenState::Failed, Some("save_failed"), None),
        }
    } else { (SetupTokenState::Failed, Some("capture_failed"), None) };
    // Terminal events are sent after process termination and staging cleanup.
    drop(staging);
    guard.publish(state, None, reason, status);
    RunAudit { child_stopped: stopped, wiped_buffer: std::mem::take(&mut raw.0) }
}

#[cfg(test)]
#[path = "setup_token_tests.rs"]
mod tests;
