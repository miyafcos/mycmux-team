//! A private, bounded setup-token PTY. Its output never enters the terminal manager.
use std::{
    io::{Read, Write}, path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, SyncSender}, Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use portable_pty::{native_pty_system, Child, CommandBuilder, ExitStatus, MasterPty, PtySize};
use serde::Serialize;
use super::{claude::ClaudePaths, launch_tokens::{self, LaunchTokenStatus, LaunchTokenStore, SaveOutcome},
    staging, token_owner::LaunchOwnerCheck, ERR_LAUNCH_TOKEN_OWNER_MISMATCH};

const OUTPUT_LIMIT: usize = 1024 * 1024;
const OUTPUT_QUEUE_CAPACITY: usize = 8;
const POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(unix)]
const PROCESS_GROUP_EXIT_TIMEOUT: Duration = Duration::from_millis(250);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(windows)]
const OUTPUT_CANCEL_GRACE: Duration = Duration::from_millis(250);
const TOKEN_PREFIX: &str = "sk-ant-oat";
const PTY_ROWS: u16 = 40;
// Preserves the fact that a displayed row was edited without emulating its cells.
const EDITED_ROW: u8 = b'\x08';
#[cfg(windows)]
#[path = "setup_token_windows.rs"]
mod windows_job;
pub(super) const AUTH_ENV_KEYS: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
];
// Claude Code 2.1.323 setup-token: terminal error view and revoked-token gate.
// Match known screen lines, never generic words in startup notices.
const OAUTH_ERROR: &str = "OAuth error:";
const RETRY_LINE: &str = "Press Enter to retry";
const REVOKED_LINE: &str = "Anthropic reported the token revoked; it was not shown.";
const UNAVAILABLE: &str = "cli_account.error.setup_unavailable";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupTokenState {
    Starting, WaitingBrowser, CodeAvailable, Confirming, CheckingOwner, Saved, Mismatch, Failed, Cancelled, Timeout,
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
        if attempt.event.state == SetupTokenState::Confirming {
            attempt.event.url = None;
        }
        if attempt.event.state.terminal() {
            attempt.active = false;
            attempt.accepting_cancel = false;
            attempt.accepting_code = false;
            // Approval URLs are only useful during the current authorization.
            attempt.event.url = None;
            // The attempt has finished with its staging directory.
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
    fn wipe(&mut self) { Self::wipe_slice(&mut self.0); }

    fn wipe_slice(bytes: &mut [u8]) {
        for byte in bytes {
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
fn cursor_position(current: u16, command: u8, params: &[u8]) -> Option<(u16, u16)> {
    let mut fields = params.split(|byte| *byte == b';');
    let number = |field: &[u8]| {
        if field.is_empty() { return Some(1); }
        if !field.iter().all(u8::is_ascii_digit) { return None; }
        let value = std::str::from_utf8(field).ok()?.parse::<u16>().ok()?;
        (value <= i16::MAX as u16).then_some(value)
    };
    let first = number(fields.next()?)?.max(1);
    let column = match fields.next() {
        None => 1,
        Some(column) if matches!(command, b'H' | b'f') && fields.next().is_none() => number(column)?,
        Some(_) => return None,
    };
    let row = match command {
        b'A' | b'F' => current.saturating_sub(first).max(1),
        b'B' | b'E' => current.saturating_add(first).min(PTY_ROWS),
        b'd' | b'H' | b'f' => first.min(PTY_ROWS),
        _ => return None,
    };
    Some((row, column))
}

fn finish_row(plain: &mut Vec<u8>, edited: &mut bool) {
    if std::mem::take(edited) { plain.push(EDITED_ROW); }
    plain.push(b'\n');
}

pub(super) fn strip_controls(raw: &[u8]) -> SecretBytes {
    // A CR edit marker is the only added byte that need not replace a
    // control byte. Reserve space up front to avoid reallocating plaintext.
    let cr_count = raw.iter().filter(|byte| **byte == b'\r').count();
    let mut plain = Vec::with_capacity(raw.len() + cr_count);
    let mut at = 0;
    let mut row = 1;
    let mut edited = false;
    let mut after_cr = false;
    // Once display text (including spaces and tabs) has been seen, a same-row
    // H/f can be a rewrite even after a cursor move or screen clear.
    let mut seen_text = false;
    while at < raw.len() {
        match raw[at] {
            0x1b => {
                at += 1;
                if at >= raw.len() { break; }
                match raw[at] {
                    b'[' => {
                        at += 1;
                        let start = at;
                        while at < raw.len() && !(0x40..=0x7e).contains(&raw[at]) { at += 1; }
                        if at >= raw.len() { break; }
                        let command = raw[at];
                        if matches!(command, b'C' | b'D' | b'G' | 0x60 | b'P' | b'@' | b'X') {
                            edited = true;
                        } else if matches!(command, b'A' | b'B' | b'E' | b'F' | b'd' | b'H' | b'f') {
                            match cursor_position(row, command, &raw[start..at]) {
                                Some((next, _)) if next != row => {
                                    finish_row(&mut plain, &mut edited);
                                    row = next;
                                    after_cr = false;
                                }
                                Some((_, column)) => {
                                    edited |= matches!(command, b'H' | b'f')
                                        && (seen_text || column != 1);
                                }
                                None => edited = true,
                            }
                        }
                        at += 1;
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
            b'\n' => {
                finish_row(&mut plain, &mut edited);
                row = (row + 1).min(PTY_ROWS);
                after_cr = false;
                at += 1;
            }
            b'\r' => { plain.push(b'\r'); after_cr = true; at += 1; }
            b'\t' => { plain.push(b'\t'); seen_text = true; at += 1; }
            b'\x08' => { edited = true; at += 1; }
            0..=31 | 127 => at += 1,
            _ => {
                edited |= std::mem::take(&mut after_cr);
                plain.push(raw[at]);
                seen_text = true;
                at += 1;
            }
        }
    }
    if edited { plain.push(EDITED_ROW); }
    SecretBytes(plain)
}
fn valid_token(value: &str) -> bool {
    value.strip_prefix(TOKEN_PREFIX).is_some_and(|rest| {
        let b = rest.as_bytes();
        (23..=515).contains(&b.len()) && b[0].is_ascii_digit() && b[1].is_ascii_digit()
            && b[2] == b'-' && b[3..].iter().copied().all(token_byte)
    })
}
fn token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}
fn token_fragment(line: &str) -> bool {
    !line.is_empty() && line.bytes().all(token_byte)
}
fn ascii_position(line: &[u8], text: &str) -> Option<usize> {
    line.windows(text.len()).position(|part| part == text.as_bytes())
}
// Retain readable text on both sides of an undecodable byte sequence. The
// bytes between spans cannot establish a token or make a quoted error exact.
fn readable_spans(line: &[u8]) -> impl Iterator<Item = &str> {
    line.utf8_chunks().map(|chunk| chunk.valid().trim()).filter(|span| !span.is_empty())
}

fn partial_token(line: &[u8], complete: bool) -> bool {
    let mut last = None;
    for word in readable_spans(line).flat_map(str::split_whitespace) {
        if word.starts_with("sk-") && TOKEN_PREFIX.starts_with(word) { return true; }
        last = Some(word);
    }
    !complete && last.is_some_and(|word| TOKEN_PREFIX.starts_with(word))
}

pub(super) fn extract_token(plain: &[u8]) -> Option<SecretBytes> {
    let mut marker = false;
    let mut candidate: Option<&str> = None;
    let mut previous_candidate = false;
    for line in plain.split_inclusive(|byte| *byte == b'\n') {
        let complete = line.ends_with(b"\n");
        let bytes = line.strip_suffix(b"\n").unwrap_or(line);
        let edited = bytes.ends_with(&[EDITED_ROW]);
        let bytes = bytes.strip_suffix(&[EDITED_ROW]).unwrap_or(bytes);
        let has_token = ascii_position(bytes, TOKEN_PREFIX).is_some();
        let has_heading = ascii_position(bytes, "OAuth token").is_some();
        let mut spans = readable_spans(bytes);
        let first = spans.next();
        // A wrapped or unreadable continuation can make an otherwise valid
        // prefix ambiguous. Known unrelated text breaks the continuation.
        let could_be_continuation = previous_candidate && !has_heading && !has_token
            && match first {
                Some(first) => token_fragment(first) && spans.all(token_fragment),
                None => std::str::from_utf8(bytes).is_err(),
            };
        if partial_token(bytes, complete && !edited) || could_be_continuation { return None; }
        if has_token || has_heading {
            // Only an unedited, complete, UTF-8 row can supply a token.
            let line = std::str::from_utf8(bytes).ok()?.trim();
            if edited || (has_heading && has_token) || (!complete && has_token) { return None; }
            if has_heading {
                marker |= complete;
            } else {
                if !marker || !valid_token(line) || candidate.is_some_and(|value| value != line) { return None; }
                candidate = Some(line);
                previous_candidate = true;
            }
        } else if first.is_some() {
            previous_candidate = false;
        }
    }
    candidate.map(|value| SecretBytes(value.as_bytes().to_vec()))
}
pub(super) fn authorization_url(plain: &[u8]) -> Option<String> {
    plain.split(|byte| matches!(*byte, b'\n' | b'\r' | EDITED_ROW))
        .filter_map(|line| std::str::from_utf8(line).ok())
        .flat_map(str::split_whitespace).find(|word| word.starts_with("https://") && word.contains("/oauth/authorize?") && word.len() <= 8192
            && !word.contains("sk-ant-oat") && word.bytes().all(|byte| !byte.is_ascii_control()))
        .map(str::to_owned)
}
fn cli_error(plain: &[u8]) -> bool {
    // A CR starts another visible message at column one. It does not end a
    // token row. The edit marker is synthetic and contains no visible text.
    plain.split(|byte| matches!(*byte, b'\n' | b'\r' | EDITED_ROW)).any(|bytes| {
        let mut spans = readable_spans(bytes);
        let Some(first) = spans.next() else { return false; };
        let last = spans.last();
        first.starts_with(OAUTH_ERROR)
            || (last.is_none() && first.trim_end_matches('.') == RETRY_LINE)
            || (last.unwrap_or(first).ends_with(REVOKED_LINE)
                && !first.starts_with("https://") && ascii_position(bytes, TOKEN_PREFIX).is_none())
    })
}
pub struct RunOptions {
    pub timeout: Duration,
    pub token_exit_grace: Duration,
    pub confirm_exit_grace: Duration,
    pub fallback_after: Duration,
}
impl Default for RunOptions {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(600), token_exit_grace: Duration::from_secs(5),
            confirm_exit_grace: Duration::from_secs(5), fallback_after: Duration::from_secs(3) }
    }
}
pub struct RunAudit { pub child_stopped: bool, pub wiped_buffer: Vec<u8> }
struct StagingGuard<F: Fn(&Path)> { path: PathBuf, cleanup: F }
impl<F: Fn(&Path)> Drop for StagingGuard<F> { fn drop(&mut self) { (self.cleanup)(&self.path); } }
#[cfg(all(windows, test))]
type TestReader = Box<dyn Read + Send>;

#[cfg(all(windows, test))]
type BeforeJobRelease = Box<dyn FnOnce(std::os::windows::io::BorrowedHandle<'_>) + Send>;

#[cfg(all(windows, test))]
#[derive(Default)]
struct PtyTestHooks {
    wrap_reader: Option<Box<dyn FnOnce(TestReader) -> TestReader + Send>>,
    before_job_release: Option<BeforeJobRelease>,
    output: windows_job::OutputTestHooks,
}

struct PrivatePty {
    #[cfg(all(windows, test))]
    test_hooks: PtyTestHooks,
    #[cfg(windows)]
    job: Option<windows_job::SetupJob>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    _master: Box<dyn MasterPty + Send>,
    stopped: Option<bool>,
}
impl PrivatePty {
    fn finished(&mut self, _confirmation_failed: bool) -> Result<Option<ExitStatus>, CaptureFailure> {
        let status = self.child.try_wait().map_err(|_| CaptureFailure::CaptureFailed)?;
        #[cfg(windows)]
        if status.as_ref().is_some_and(ExitStatus::success) {
            let counts = self.job.as_ref().expect("job is open while polling")
                .accounting().map_err(|_| CaptureFailure::CaptureFailed)?;
            if counts.ActiveProcesses != 0 { return Ok(None); }
            // TotalProcesses includes descendants that exited between polls.
            // With a failed Enter, a wrapper's zero cannot verify their exit.
            if _confirmation_failed && counts.TotalProcesses > 1 {
                return Err(CaptureFailure::CaptureFailed);
            }
        }
        Ok(status)
    }

    fn stop(&mut self) -> bool {
        if let Some(stopped) = self.stopped { return stopped; }
        #[cfg(windows)]
        // Release the kill-on-close handle here, including when stop failed.
        // ConPTY Close runs elsewhere and must not own the job.
        let stopped = self.job.take().is_some_and(|job| {
            let stopped = job.stop().unwrap_or(false);
            #[cfg(test)]
            if let Some(observe) = self.test_hooks.before_job_release.take() {
                observe(job.handle());
            }
            stopped
        });
        #[cfg(not(windows))]
        let stopped = self.stop_child();
        self.stopped = Some(stopped);
        stopped
    }

    #[cfg(not(windows))]
    fn stop_child(&mut self) -> bool {
        // portable-pty starts Unix children as session/process-group leaders.
        // Descendants may otherwise keep the private PTY reader open forever.
        #[cfg(unix)]
        let group = self.child.process_id().filter(|pid| *pid > 1 && *pid <= i32::MAX as u32)
            .map(|pid| -(pid as i32));
        #[cfg(unix)]
        if let Some(group) = group {
            // The signal's return value does not establish that the group exited.
            let _ = unsafe { libc::kill(group, libc::SIGKILL) };
        }
        if self.child.try_wait().ok().flatten().is_none() { let _ = self.child.kill(); }
        if self.child.wait().is_err() { return false; }
        #[cfg(unix)]
        {
            group.is_none_or(|group| confirm_process_group_exit(|| {
                // Probe after reaping even when SIGKILL was accepted. EPERM
                // means the group may still exist, including on macOS.
                let result = unsafe { libc::kill(group, 0) };
                result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            }, PROCESS_GROUP_EXIT_TIMEOUT))
        }
        #[cfg(not(unix))]
        true
    }
}
impl Drop for PrivatePty { fn drop(&mut self) { self.stop(); } }

#[cfg(unix)]
fn confirm_process_group_exit(
    mut group_has_exited: impl FnMut() -> bool, timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    while !group_has_exited() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL.min(remaining));
    }
    true
}

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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureFailure {
    Cancelled,
    Timeout,
    CliError,
    CaptureFailed,
    OutputLimit,
}

impl CaptureFailure {
    fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::CliError => "cli_error",
            Self::CaptureFailed => "capture_failed",
            Self::OutputLimit => "output_limit",
        }
    }

    fn state(self) -> SetupTokenState {
        match self {
            Self::Cancelled => SetupTokenState::Cancelled,
            Self::Timeout => SetupTokenState::Timeout,
            _ => SetupTokenState::Failed,
        }
    }
}

fn report_unconfirmed_stop(previous: Option<CaptureFailure>) {
    let previous_reason = previous.map_or("none", CaptureFailure::code);
    crate::diag::warn("claude_setup_token", &format!("stop_unconfirmed previous_reason={previous_reason}"));
}

enum PtyOutput {
    Data(SecretBytes),
    Eof,
    ReadFailed,
}

fn read_pty_output(mut reader: impl Read, sender: SyncSender<PtyOutput>, stop_reading: &AtomicBool) {
    let mut buffer = SecretBytes(vec![0; 8192]);
    let mut capture = true;
    while !stop_reading.load(Ordering::SeqCst) {
        let end = match reader.read(&mut buffer.0) {
            Ok(0) => PtyOutput::Eof,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                buffer.wipe();
                continue;
            }
            #[cfg(windows)]
            Err(error) if error.raw_os_error() == Some(windows::Win32::Foundation::ERROR_BROKEN_PIPE.0 as i32) => PtyOutput::Eof,
            Err(_) => PtyOutput::ReadFailed,
            Ok(count) => {
                let used = &mut buffer.0[..count];
                let chunk = capture.then(|| SecretBytes(used.to_vec()));
                // Wipe before queueing, since a full queue can block the sender.
                SecretBytes::wipe_slice(used);
                if let Some(chunk) = chunk { capture = sender.send(PtyOutput::Data(chunk)).is_ok(); }
                // After capture closes, keep draining with the same buffer.
                continue;
            }
        };
        if capture { let _ = sender.send(end); }
        break;
    }
}

fn record_output(raw: &mut SecretBytes, output: PtyOutput) -> Result<bool, CaptureFailure> {
    match output {
        PtyOutput::Data(chunk) => {
            if raw.0.len() + chunk.0.len() > OUTPUT_LIMIT { return Err(CaptureFailure::OutputLimit); }
            raw.0.extend_from_slice(chunk.as_slice());
            Ok(false)
        }
        PtyOutput::Eof => Ok(true),
        PtyOutput::ReadFailed => Err(CaptureFailure::CaptureFailed),
    }
}

fn record_pending_output(receiver: &Receiver<PtyOutput>, raw: &mut SecretBytes) -> Result<bool, CaptureFailure> {
    for output in receiver.try_iter().take(OUTPUT_QUEUE_CAPACITY) {
        if record_output(raw, output)? { return Ok(true); }
    }
    Ok(false)
}

fn drain_output(receiver: &Receiver<PtyOutput>, raw: &mut SecretBytes, timeout: Duration) -> Result<(), CaptureFailure> {
    let deadline = Instant::now() + timeout;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) {
        match receiver.recv_timeout(remaining) {
            Ok(output) => if record_output(raw, output)? { return Ok(()); },
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(CaptureFailure::CaptureFailed),
            Err(mpsc::RecvTimeoutError::Timeout) => break,
        }
    }
    // Account for output already read by the worker at the cutoff. A timeout
    // remains a capture failure even if EOF arrives during this last pass.
    record_pending_output(receiver, raw)?;
    Err(CaptureFailure::CaptureFailed)
}

fn capture_complete(raw: &SecretBytes) -> Result<SecretBytes, CaptureFailure> {
    let plain = strip_controls(raw.as_slice());
    if cli_error(plain.as_slice()) { return Err(CaptureFailure::CliError); }
    extract_token(plain.as_slice()).ok_or(CaptureFailure::CaptureFailed)
}

#[allow(clippy::too_many_arguments)]
pub fn run_attempt(
    registry: &SetupTokenRegistry, initial: SetupTokenEvent, control: SetupControl,
    base: &Path, live: &ClaudePaths, command: CommandBuilder, options: RunOptions,
    secrets: &dyn LaunchTokenStore, check_owner: impl FnOnce(&str) -> LaunchOwnerCheck,
    cleanup_staging: impl Fn(&Path), emit: impl FnMut(SetupTokenEvent),
) -> RunAudit {
    run_attempt_with_pty(registry, initial, control, base, live, command, options, secrets,
        check_owner, cleanup_staging, emit, |_| {}, drop)
}

#[allow(clippy::too_many_arguments)]
fn run_attempt_with_pty(
    registry: &SetupTokenRegistry, initial: SetupTokenEvent, control: SetupControl,
    base: &Path, live: &ClaudePaths, mut command: CommandBuilder, options: RunOptions,
    secrets: &dyn LaunchTokenStore, check_owner: impl FnOnce(&str) -> LaunchOwnerCheck,
    cleanup_staging: impl Fn(&Path), emit: impl FnMut(SetupTokenEvent),
    prepare_pty: impl FnOnce(&mut PrivatePty),
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
        let pair = native_pty_system().openpty(PtySize { cols: 512, rows: PTY_ROWS, pixel_width: 0, pixel_height: 0 }).map_err(|_| ())?;
        #[cfg(windows)]
        let reader = pair.master.take_reader().map_err(|_| ())?;
        #[cfg(not(windows))]
        let reader = pair.master.try_clone_reader().map_err(|_| ())?;
        let writer = pair.master.take_writer().map_err(|_| ())?;
        if control.cancelled.load(Ordering::SeqCst) { return Err(()); }
        #[cfg(windows)]
        let job = windows_job::SetupJob::new().map_err(|_| ())?;
        #[cfg(windows)]
        let child = pair.slave.spawn_command_in_job(command, job.handle()).map_err(|_| ())?;
        #[cfg(not(windows))]
        let child = pair.slave.spawn_command(command).map_err(|_| ())?;
        drop(pair.slave);
        Ok((PrivatePty {
            #[cfg(all(windows, test))]
            test_hooks: PtyTestHooks::default(),
            #[cfg(windows)]
            job: Some(job),
            child, writer, _master: pair.master, stopped: None,
        }, reader))
    };
    let (mut pty, reader) = match spawn() {
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
    prepare_pty(&mut pty);
    #[cfg(all(windows, test))]
    let reader = match pty.test_hooks.wrap_reader.take() {
        Some(wrap) => wrap(reader),
        None => reader,
    };
    let (sender, receiver) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
    let stop_reading = Arc::new(AtomicBool::new(false));
    let reader_thread = {
        let stop_reading = stop_reading.clone();
        std::thread::spawn(move || read_pty_output(reader, sender, &stop_reading))
    };
    guard.publish(SetupTokenState::WaitingBrowser, None, None, None);
    let started = Instant::now();
    let mut candidate_since = None;
    let mut confirmation: Option<(Instant, bool)> = None;
    let mut code_enter_at: Option<Instant> = None;
    let mut fallback_shown = false;
    let mut last_url = None;
    let mut failure = None;
    let mut parsed_len = 0;
    let mut valid_candidate = false;
    let mut eof = false;
    loop {
        if eof {
            std::thread::sleep(POLL_INTERVAL);
        } else {
            let result = match receiver.recv_timeout(POLL_INTERVAL) {
                Ok(output) => record_output(&mut raw, output).and_then(|eof| {
                    if eof { Ok(true) } else { record_pending_output(&receiver, &mut raw) }
                }),
                Err(mpsc::RecvTimeoutError::Timeout) => Ok(false),
                Err(mpsc::RecvTimeoutError::Disconnected) => Err(CaptureFailure::CaptureFailed),
            };
            match result {
                Ok(end) => eof = end,
                Err(reason) => { failure = Some(reason); break; }
            }
        }
        if control.cancelled.load(Ordering::SeqCst) { failure = Some(CaptureFailure::Cancelled); break; }
        if started.elapsed() >= options.timeout { failure = Some(CaptureFailure::Timeout); break; }
        if raw.0.len() != parsed_len {
            parsed_len = raw.0.len();
            let plain = strip_controls(raw.as_slice());
            if cli_error(plain.as_slice()) { failure = Some(CaptureFailure::CliError); break; }
            valid_candidate = extract_token(plain.as_slice()).is_some();
            if candidate_since.is_none() {
                if valid_candidate {
                    candidate_since = Some(Instant::now());
                    registry.close_input(id);
                    drop(control.codes.try_recv());
                    code_enter_at = None;
                    guard.publish(SetupTokenState::Confirming, None, None, None);
                } else if let Some(url) = authorization_url(plain.as_slice()).filter(|url| last_url.as_ref() != Some(url)) {
                    last_url = Some(url);
                    guard.publish(if fallback_shown { SetupTokenState::CodeAvailable } else { SetupTokenState::WaitingBrowser }, last_url.clone(), None, None);
                    // The callback may queue a code while new output arrives.
                    continue;
                }
            }
        }
        match pty.finished(confirmation.is_some_and(|(_, sent)| !sent)) {
            Ok(Some(status)) => {
                if !status.success() { failure = Some(CaptureFailure::CliError); }
                break;
            }
            Ok(None) => {}
            Err(reason) => { failure = Some(reason); break; }
        }
        if let Some((at, sent)) = confirmation {
            if at.elapsed() >= options.confirm_exit_grace {
                if !sent { failure = Some(CaptureFailure::CaptureFailed); }
                break;
            }
        } else if let Some(at) = candidate_since {
            if at.elapsed() >= options.token_exit_grace {
                if !valid_candidate {
                    failure = Some(CaptureFailure::CaptureFailed);
                    break;
                }
                let sent = !eof && pty.writer.write_all(b"\r").and_then(|_| pty.writer.flush()).is_ok();
                confirmation = Some((Instant::now(), sent));
            }
        } else if eof {
            failure = Some(CaptureFailure::CaptureFailed);
            break;
        } else if let Some(at) = code_enter_at {
            if Instant::now() >= at {
                code_enter_at = None;
                if pty.writer.write_all(b"\r").and_then(|_| pty.writer.flush()).is_err() {
                    failure = Some(CaptureFailure::CliError); break;
                }
            }
        } else if let Ok(mut code) = control.codes.try_recv() {
            let sent = pty.writer.write_all(code.as_slice()).and_then(|_| pty.writer.flush());
            code.wipe();
            if sent.is_err() { failure = Some(CaptureFailure::CliError); break; }
            code_enter_at = Some(Instant::now() + Duration::from_millis(150));
        } else if started.elapsed() >= options.fallback_after && !fallback_shown {
            fallback_shown = true;
            guard.publish(SetupTokenState::CodeAvailable, last_url.clone(), None, None);
        }
    }
    registry.close_input(id);
    drop(control.codes.try_recv());
    if failure.is_none() {
        match pty.child.try_wait() {
            Ok(Some(status)) if !status.success() => failure = Some(CaptureFailure::CliError),
            Err(_) => failure = Some(CaptureFailure::CaptureFailed),
            _ => {}
        }
    }
    let stopped = pty.stop();
    if !stopped {
        report_unconfirmed_stop(failure);
        failure = Some(CaptureFailure::CaptureFailed);
    }
    // ConPTY can write a final frame during Close. The reader owns the only
    // output handle and drains independently of the writer and master.
    let close_deadline = Instant::now() + OUTPUT_DRAIN_TIMEOUT;
    #[cfg(windows)]
    let drain_deadline = close_deadline - OUTPUT_CANCEL_GRACE;
    #[cfg(not(windows))]
    let drain_deadline = close_deadline;
    #[cfg(all(windows, test))]
    let output_hooks = std::mem::take(&mut pty.test_hooks.output);
    let close_thread = std::thread::spawn(move || close_pty(pty));
    let drain = if eof || failure.is_some() {
        Ok(())
    } else {
        drain_output(&receiver, &mut raw, drain_deadline.saturating_duration_since(Instant::now()))
    };
    drop(receiver); // Wipe queued chunks and switch the worker to discarding.
    #[cfg(windows)]
    {
        let completion = windows_job::finish_output(
            reader_thread, close_thread, stop_reading, drain_deadline, close_deadline,
            #[cfg(test)]
            output_hooks,
        );
        if !completion.complete() {
            failure.get_or_insert(drain.err().unwrap_or(CaptureFailure::CaptureFailed));
        }
    }
    #[cfg(not(windows))]
    {
        drop(close_thread);
        stop_reading.store(true, Ordering::SeqCst);
        if reader_thread.is_finished() { let _ = reader_thread.join(); }
    }
    let captured = if failure.is_none() {
        match drain.and_then(|()| capture_complete(&raw)) {
            Ok(token) => Some(token),
            Err(reason) => {
                failure = Some(reason);
                None
            }
        }
    } else { None };
    raw.wipe();
    let (state, reason, status) = if let Some(reason) = failure {
        (reason.state(), Some(reason.code()), None)
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
