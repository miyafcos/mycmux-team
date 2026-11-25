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
use super::{claude::ClaudePaths, launch_tokens::{self, LaunchTokenStatus, LaunchTokenStore, SaveOutcome, ERR_LAUNCH_TOKEN_REPLACEMENT_UNVERIFIED},
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
// Preserve the existing boundaries for URL and CLI error diagnostics.
const DIAGNOSTIC_BOUNDARY: u8 = b'\x08';
#[path = "setup_token_screen.rs"]
mod screen;
use screen::{ControlFamily, Screen, ScreenUncertainty, VisibleLine, PTY_COLS, PTY_ROWS};
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
    code_opened: bool,
    code_submitted: bool,
    accepting_code: bool,
}
#[cfg(all(unix, test))]
type QueueOutput = Box<dyn FnOnce(&SyncSender<PtyOutput>) + Send>;

pub struct SetupControl {
    cancelled: Arc<AtomicBool>,
    codes: Receiver<SecretBytes>,
    #[cfg(all(unix, test))]
    queue_output: Option<QueueOutput>,
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
            active: true, accepting_cancel: true, code_opened: false, code_submitted: false, accepting_code: true });
        Ok((event, SetupControl {
            cancelled, codes: receiver,
            #[cfg(all(unix, test))]
            queue_output: None,
        }))
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
        let attempt = inner.as_mut().filter(|attempt| attempt.active && attempt.accepting_code && attempt.code_opened
            && !attempt.code_submitted && !attempt.cancel.load(Ordering::SeqCst) && attempt.event.login_id == login_id)
            .ok_or_else(|| UNAVAILABLE.to_string())?;
        attempt.codes.try_send(code).map_err(|_| UNAVAILABLE.to_string())?;
        attempt.code_submitted = true;
        Ok(())
    }
    pub(super) fn publish(&self, login_id: &str, state: SetupTokenState, url: Option<String>,
        reason: Option<String>, status: Option<LaunchTokenStatus>) -> Option<SetupTokenEvent> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt = inner.as_mut().filter(|attempt| attempt.event.login_id == login_id && attempt.active)?;
        if let Some(url) = url { attempt.event.url = Some(url); }
        attempt.code_opened |= state == SetupTokenState::CodeAvailable;
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
    fn close_input(&self, login_id: &str) -> Option<bool> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt = inner.as_mut().filter(|attempt| attempt.active && attempt.event.login_id == login_id)?;
        attempt.accepting_code = false;
        Some(attempt.code_submitted)
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
    if std::mem::take(edited) { plain.push(DIAGNOSTIC_BOUNDARY); }
    plain.push(b'\n');
}

struct DiagnosticOutput {
    text: SecretBytes,
    completed_len: usize,
    last_line_start: usize,
    errors_at_lf: Vec<(usize, std::ops::Range<usize>)>,
}

impl DiagnosticOutput {
    fn as_slice(&self) -> &[u8] {
        self.text.as_slice()
    }

    fn completed_lines(&self) -> &[u8] {
        &self.as_slice()[..self.completed_len]
    }
}

// Authorization and error detection use the existing output scan.
fn strip_controls(raw: &[u8]) -> DiagnosticOutput {
    // A CR edit marker is the only added byte that need not replace a
    // control byte. Reserve space up front to avoid reallocating plaintext.
    let cr_count = raw.iter().filter(|byte| **byte == b'\r').count();
    let mut plain = Vec::with_capacity(raw.len() + cr_count);
    let mut completed_len = 0;
    let mut line_start = 0;
    let mut errors_at_lf = Vec::new();
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
                                    line_start = plain.len();
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
                completed_len = plain.len();
                if cli_error(&plain[line_start..completed_len]) {
                    errors_at_lf.push((at, line_start..completed_len));
                }
                line_start = completed_len;
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
    if edited { plain.push(DIAGNOSTIC_BOUNDARY); }
    DiagnosticOutput {
        text: SecretBytes(plain), completed_len, last_line_start: line_start, errors_at_lf,
    }
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
fn ascii_position(line: &[u8], text: &str) -> Option<usize> {
    line.windows(text.len()).position(|part| part == text.as_bytes())
}
// Retain readable text on both sides of an undecodable byte sequence. The
// bytes between spans cannot establish a token or make a quoted error exact.
fn readable_spans(line: &[u8]) -> impl Iterator<Item = &str> {
    line.utf8_chunks()
        .flat_map(|chunk| chunk.valid().split('\0'))
        .map(str::trim)
        .filter(|span| !span.is_empty())
}

fn token_shape(text: &str) -> bool {
    text.len() >= 2 && text.bytes().all(token_byte)
        && (text.starts_with(TOKEN_PREFIX) || TOKEN_PREFIX.starts_with(text))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScreenRejection {
    NoHeading,
    ValueLineNotToken,
    ValueLineCol512,
    HeadingCol512,
    BelowNotBlankOrHint,
    ValueOnLastRow,
    ConflictingValueLines,
    UncertainScreen(ControlFamily),
    UncertainRow,
}

impl ScreenRejection {
    fn code(self) -> &'static str {
        match self {
            Self::NoHeading => "no_heading",
            Self::ValueLineNotToken => "value_line_not_token",
            Self::ValueLineCol512 => "value_line_col512",
            Self::HeadingCol512 => "heading_col512",
            Self::BelowNotBlankOrHint => "below_not_blank_or_hint",
            Self::ValueOnLastRow => "value_on_last_row",
            Self::ConflictingValueLines => "conflicting_value_lines",
            Self::UncertainScreen(_) => "uncertain_screen",
            Self::UncertainRow => "uncertain_row",
        }
    }
}

fn heading_shape(row: &str) -> bool {
    matches!(row, "OAuth token" | "OAuth token:" | "Your OAuth token:" | "Your OAuth token (valid for 1 year):")
}

fn line_text(line: &VisibleLine) -> &str {
    // All rendered characters are UTF-8, including the internal NUL
    // placeholder for malformed bytes that did not decode to a glyph.
    std::str::from_utf8(line.text.as_slice()).expect("rendered UTF-8").trim()
}

#[derive(Default)]
struct ScreenCounts {
    visible_rows: usize,
    value_rows: usize,
    heading_rows: usize,
}

impl ScreenCounts {
    fn from_screen(screen: &Screen) -> Self {
        let mut counts = Self::default();
        for line in screen.visible_lines() {
            let row = line_text(&line);
            counts.visible_rows += usize::from(!row.is_empty());
            counts.value_rows += usize::from(token_shape(row));
            counts.heading_rows += usize::from(heading_shape(row));
        }
        counts
    }
}

fn screen_candidate(screen: &Screen) -> Result<(usize, SecretBytes), ScreenRejection> {
    let lines = screen.lines().map_err(|error| match error {
        ScreenUncertainty::Unsupported(control) => ScreenRejection::UncertainScreen(control),
        ScreenUncertainty::UncertainRow => ScreenRejection::UncertainRow,
    })?;
    let text: Vec<&str> = lines.iter().map(line_text).collect();
    let mut shape = None;
    for &row in &text {
        if token_shape(row) {
            if shape.is_some_and(|value| value != row) {
                return Err(ScreenRejection::ConflictingValueLines);
            }
            shape = Some(row);
        }
    }
    let value = shape.filter(|value| valid_token(value));
    let mut first_rejection = None;
    for (index, &heading) in text.iter().enumerate() {
        if !heading_shape(heading) {
            continue;
        }
        let detail = match value.filter(|value| text.get(index + 1) == Some(value)) {
            _ if lines[index].ambiguous_width
                || lines.get(index + 1).is_some_and(|line| line.ambiguous_width) =>
                ScreenRejection::UncertainRow,
            _ if !lines[index].right_edge_blank => ScreenRejection::HeadingCol512,
            None => ScreenRejection::ValueLineNotToken,
            Some(_) if !lines[index + 1].right_edge_blank => ScreenRejection::ValueLineCol512,
            Some(value) => match text.get(index + 2) {
                None => ScreenRejection::ValueOnLastRow,
                // A malformed byte alone cannot establish readable guidance.
                Some(guide) if guide.is_empty() || guide.bytes().any(|byte| byte != 0 && !token_byte(byte)) =>
                    return Ok((index, SecretBytes(value.as_bytes().to_vec()))),
                Some(_) => ScreenRejection::BelowNotBlankOrHint,
            },
        };
        first_rejection.get_or_insert(detail);
    }
    Err(first_rejection.unwrap_or(ScreenRejection::NoHeading))
}

pub(super) fn authorization_url(plain: &[u8]) -> Option<String> {
    plain.split(|byte| matches!(*byte, b'\n' | b'\r' | DIAGNOSTIC_BOUNDARY))
        .filter_map(|line| std::str::from_utf8(line).ok())
        .flat_map(str::split_whitespace).find(|word| word.starts_with("https://") && word.contains("/oauth/authorize?") && word.len() <= 8192
            && !word.contains("sk-ant-oat") && word.bytes().all(|byte| !byte.is_ascii_control()))
        .map(str::to_owned)
}
fn cli_error_message(bytes: &[u8]) -> Option<&str> {
    let mut spans = readable_spans(bytes);
    let first = spans.next()?;
    let last = spans.last();
    if first.starts_with(OAUTH_ERROR) || (last.is_none() && first.trim_end_matches('.') == RETRY_LINE) {
        return Some(first);
    }
    let suffix = last.unwrap_or(first);
    (suffix.ends_with(REVOKED_LINE) && !first.starts_with("https://")
        && ascii_position(bytes, TOKEN_PREFIX).is_none()).then_some(suffix)
}

fn diagnostic_errors(plain: &[u8]) -> impl Iterator<Item = &str> {
    // Keep the diagnostic boundaries inside each completed output line.
    plain.split(|byte| matches!(*byte, b'\n' | b'\r' | DIAGNOSTIC_BOUNDARY))
        .filter_map(cli_error_message)
}

fn cli_error(plain: &[u8]) -> bool {
    diagnostic_errors(plain).next().is_some()
}

fn matches_cursor_error(plain: &[u8], screen: &Screen) -> bool {
    let mut diagnosed = diagnostic_errors(plain).peekable();
    if diagnosed.peek().is_none() { return false; }
    let Some(line) = screen.cursor_line() else { return false; };
    let Some(visible) = cli_error_message(line.text.as_slice()) else { return false; };
    diagnosed.any(|message| {
        message == visible || (message.starts_with(OAUTH_ERROR) && visible.starts_with(OAUTH_ERROR))
    })
}

fn update_screen_and_check_error(screen: &mut Screen, raw: &[u8], plain: &DiagnosticOutput, eof: bool) -> bool {
    let error_at_lf = |offset, screen: &Screen| {
        plain.errors_at_lf.binary_search_by_key(&offset, |(lf, _)| *lf).ok()
            .is_some_and(|index| {
                let range = plain.errors_at_lf[index].1.clone();
                matches_cursor_error(&plain.as_slice()[range], screen)
            })
    };
    if eof {
        screen.finish(raw, error_at_lf);
    } else {
        screen.update(raw, error_at_lf);
    }
    if screen.is_unsupported() {
        return cli_error(if eof { plain.as_slice() } else { plain.completed_lines() });
    }
    screen.has_verified_error() || (eof && matches_cursor_error(&plain.as_slice()[plain.last_line_start..], screen))
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
    fn finished(
        &mut self, _confirmation_failed: bool, diagnostics: &mut AttemptDiagnostics,
    ) -> Result<Option<ExitStatus>, FailureReason> {
        let status = self.child.try_wait().map_err(|_| FailureReason::ChildWaitFailed)?;
        if let Some(status) = &status {
            diagnostics.record_child_status(status);
        }
        #[cfg(windows)]
        if status.as_ref().is_some_and(ExitStatus::success) {
            let counts = self.job.as_ref().expect("job is open while polling")
                .accounting().map_err(|_| FailureReason::ChildWaitFailed)?;
            if counts.ActiveProcesses != 0 { return Ok(None); }
            // TotalProcesses includes descendants that exited between polls.
            // With a failed Enter, a wrapper's zero cannot verify their exit.
            if _confirmation_failed && counts.TotalProcesses > 1 {
                return Err(FailureReason::ConfirmationFailed);
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
    started: Instant,
    diagnostics: AttemptDiagnostics,
    screen: Screen,
}
impl<E: FnMut(SetupTokenEvent)> AttemptGuard<'_, E> {
    fn publish(&mut self, state: SetupTokenState, url: Option<String>, reason: Option<&str>) {
        if let Some(event) = self.registry.publish(self.id, state, url, reason.map(str::to_string), None) {
            (self.emit)(event);
        }
    }

    fn finish(&mut self, failure: Option<TerminalFailure>, status: Option<LaunchTokenStatus>) {
        // Close code input and snapshot acceptance under the same lock. Write
        // the diagnostic before the terminal event releases shutdown waiters.
        let Some(code_accepted) = self.registry.close_input(self.id) else { return; };
        let (state, reason) = failure.map_or((SetupTokenState::Saved, None), |failure| {
            self.diagnostics.warn(
                failure,
                ScreenCounts::from_screen(&self.screen),
                self.screen.unsupported_control(),
                code_accepted,
                self.started.elapsed().as_secs(),
            );
            let outcome = failure.outcome();
            (outcome.state(), Some(outcome.code().to_owned()))
        });
        if let Some(event) = self.registry.publish(self.id, state, None, reason, status) {
            (self.emit)(event);
        }
    }
}
impl<E: FnMut(SetupTokenEvent)> Drop for AttemptGuard<'_, E> {
    fn drop(&mut self) {
        // A panic must release the single-attempt gate even if a mutex was
        // poisoned. Never let diagnostics or an event sink unwind in Drop.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.finish(Some(TerminalFailure::status(CaptureFailure::SaveFailed)), None);
        }));
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureFailure {
    Cancelled,
    Timeout,
    CliError,
    CaptureFailed,
    LaunchFailed,
    SaveFailed,
    OwnerMismatch,
    ReplacementUnverified,
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
            Self::LaunchFailed => "launch_failed",
            Self::SaveFailed => "save_failed",
            Self::OwnerMismatch => "owner_mismatch",
            Self::ReplacementUnverified => "replacement_unverified",
        }
    }

    fn state(self) -> SetupTokenState {
        match self {
            Self::Cancelled => SetupTokenState::Cancelled,
            Self::Timeout => SetupTokenState::Timeout,
            Self::OwnerMismatch => SetupTokenState::Mismatch,
            _ => SetupTokenState::Failed,
        }
    }
}

#[derive(Clone, Copy)]
enum FailureReason {
    Status(CaptureFailure),
    Screen(ScreenRejection),
    ChildExit(u32),
    #[cfg(unix)]
    ChildSignal,
    ChildWaitFailed,
    CodeWriteFailed,
    ConfirmationFailed,
    OutputIncomplete,
}

impl FailureReason {
    fn from_child_exit(status: &ExitStatus) -> Self {
        let code = status.exit_code();
        // portable-pty 0.8.1 uses 1 for signal deaths and exposes the distinction through Display.
        #[cfg(unix)]
        if code == 1 && status.to_string().starts_with("Terminated by ") {
            return Self::ChildSignal;
        }
        Self::ChildExit(code)
    }

    fn outcome(self) -> CaptureFailure {
        match self {
            Self::Status(outcome) => outcome,
            Self::ChildExit(_) | Self::CodeWriteFailed => CaptureFailure::CliError,
            #[cfg(unix)]
            Self::ChildSignal => CaptureFailure::CliError,
            _ => CaptureFailure::CaptureFailed,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::Status(outcome) => outcome.code(),
            Self::Screen(rejection) => rejection.code(),
            Self::ChildExit(_) => "child_exit",
            #[cfg(unix)]
            Self::ChildSignal => "child_signal",
            Self::ChildWaitFailed => "child_wait_failed",
            Self::CodeWriteFailed => "code_write_failed",
            Self::ConfirmationFailed => "confirmation_failed",
            Self::OutputIncomplete => "output_incomplete",
        }
    }
}

#[derive(Clone, Copy)]
enum TerminalFailure {
    Reason(FailureReason),
    StopUnconfirmed(Option<FailureReason>),
}

impl TerminalFailure {
    fn status(outcome: CaptureFailure) -> Self {
        Self::Reason(FailureReason::Status(outcome))
    }

    fn outcome(self) -> CaptureFailure {
        match self {
            Self::Reason(reason) => reason.outcome(),
            Self::StopUnconfirmed(_) => CaptureFailure::CaptureFailed,
        }
    }
}

#[derive(Default)]
struct AttemptDiagnostics {
    received_bytes: usize,
    enter_sent: bool,
    timeout_rejection: Option<ScreenRejection>,
    child_exit_code: Option<u32>,
}

impl AttemptDiagnostics {
    fn record_child_status(&mut self, status: &ExitStatus) {
        self.child_exit_code = match FailureReason::from_child_exit(status) {
            FailureReason::ChildExit(code) => Some(code),
            _ => None,
        };
    }

    fn warn(
        &self, failure: TerminalFailure, screen: ScreenCounts, unsupported: Option<ControlFamily>,
        code_accepted: bool, elapsed_s: u64,
    ) {
        let outcome = failure.outcome().code();
        let (reason, original, previous_reason) = match failure {
            TerminalFailure::Reason(original) => {
                let reason = match (original, unsupported) {
                    (FailureReason::Status(CaptureFailure::Timeout), Some(control)) =>
                        ScreenRejection::UncertainScreen(control).code(),
                    (FailureReason::Status(CaptureFailure::Timeout), None) =>
                        self.timeout_rejection.map_or(original.code(), ScreenRejection::code),
                    _ => original.code(),
                };
                (reason, Some(original), "none")
            }
            TerminalFailure::StopUnconfirmed(previous) =>
                ("stop_unconfirmed", previous, previous.map_or("none", FailureReason::code)),
        };
        let control = match original {
            Some(FailureReason::Screen(ScreenRejection::UncertainScreen(control))) => Some(control),
            _ => unsupported,
        }.map_or("none", ControlFamily::code);
        let exit_code = self.child_exit_code
            .map_or_else(|| "none".to_owned(), |code| code.to_string());
        let Self { received_bytes, enter_sent, .. } = self;
        let ScreenCounts { visible_rows, value_rows, heading_rows } = screen;
        let os = std::env::consts::OS;
        crate::diag::warn("claude_setup_token", &format!(
            "outcome={outcome} reason={reason} control={control} exit_code={exit_code} \
             previous_reason={previous_reason} received_bytes={received_bytes} \
             visible_rows={visible_rows} value_rows={value_rows} heading_rows={heading_rows} \
             enter_sent={enter_sent} code_accepted={code_accepted} elapsed_s={elapsed_s} os={os}",
        ));
    }
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

fn record_output(raw: &mut SecretBytes, output: PtyOutput, received_bytes: &mut usize) -> Result<bool, FailureReason> {
    match output {
        PtyOutput::Data(chunk) => {
            // Include the chunk that crosses the limit without retaining it.
            *received_bytes += chunk.0.len();
            if raw.0.len() + chunk.0.len() > OUTPUT_LIMIT {
                return Err(FailureReason::Status(CaptureFailure::OutputLimit));
            }
            raw.0.extend_from_slice(chunk.as_slice());
            Ok(false)
        }
        PtyOutput::Eof => Ok(true),
        PtyOutput::ReadFailed => Err(FailureReason::OutputIncomplete),
    }
}

fn record_pending_output(receiver: &Receiver<PtyOutput>, raw: &mut SecretBytes, received_bytes: &mut usize) -> Result<bool, FailureReason> {
    for output in receiver.try_iter().take(OUTPUT_QUEUE_CAPACITY) {
        if record_output(raw, output, received_bytes)? { return Ok(true); }
    }
    Ok(false)
}

fn drain_output(receiver: &Receiver<PtyOutput>, raw: &mut SecretBytes, timeout: Duration, received_bytes: &mut usize) -> Result<(), FailureReason> {
    let deadline = Instant::now() + timeout;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) {
        match receiver.recv_timeout(remaining) {
            Ok(output) => if record_output(raw, output, received_bytes)? { return Ok(()); },
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(FailureReason::OutputIncomplete),
            Err(mpsc::RecvTimeoutError::Timeout) => break,
        }
    }
    // Account for output already read by the worker at the cutoff. A timeout
    // remains a capture failure even if EOF arrives during this last pass.
    record_pending_output(receiver, raw, received_bytes)?;
    Err(FailureReason::OutputIncomplete)
}

fn capture_complete(raw: &SecretBytes, screen: &mut Screen) -> Result<SecretBytes, FailureReason> {
    let plain = strip_controls(raw.as_slice());
    if update_screen_and_check_error(screen, raw.as_slice(), &plain, true) {
        return Err(FailureReason::Status(CaptureFailure::CliError));
    }
    screen_candidate(screen).map(|(_, token)| token).map_err(FailureReason::Screen)
}

struct ProvisionalCandidate {
    heading: usize,
    token: SecretBytes,
    since: Instant,
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
    let mut guard = AttemptGuard {
        registry, id, emit, started: Instant::now(), diagnostics: AttemptDiagnostics::default(),
        screen: Screen::default(),
    };
    let mut raw = SecretBytes(Vec::with_capacity(OUTPUT_LIMIT));
    let staging = match staging::create_staging_dir(base) {
        Ok(path) => StagingGuard { path, cleanup: cleanup_staging },
        Err(_) => {
            guard.finish(Some(TerminalFailure::status(CaptureFailure::LaunchFailed)), None);
            return RunAudit { child_stopped: true, wiped_buffer: vec![] };
        }
    };
    if control.cancelled.load(Ordering::SeqCst) {
        drop(staging);
        guard.finish(Some(TerminalFailure::status(CaptureFailure::Cancelled)), None);
        return RunAudit { child_stopped: true, wiped_buffer: vec![] };
    }
    staging::seed_claude_staging(&staging.path, live);
    scrub_setup_env(&mut command);
    command.env("CLAUDE_CONFIG_DIR", &staging.path);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.cwd(&staging.path);
    let spawn = || -> Result<_, ()> {
        let pair = native_pty_system().openpty(PtySize { cols: PTY_COLS, rows: PTY_ROWS, pixel_width: 0, pixel_height: 0 }).map_err(|_| ())?;
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
            let outcome = if control.cancelled.load(Ordering::SeqCst) {
                CaptureFailure::Cancelled
            } else {
                CaptureFailure::LaunchFailed
            };
            guard.finish(Some(TerminalFailure::status(outcome)), None);
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
    #[cfg(all(unix, test))]
    if let Some(queue_output) = control.queue_output {
        queue_output(&sender);
    }
    let stop_reading = Arc::new(AtomicBool::new(false));
    let reader_thread = {
        let stop_reading = stop_reading.clone();
        std::thread::spawn(move || read_pty_output(reader, sender, &stop_reading))
    };
    guard.publish(SetupTokenState::WaitingBrowser, None, None);
    let started = Instant::now();
    let mut candidate: Option<ProvisionalCandidate> = None;
    let mut screen_rejection = ScreenRejection::NoHeading;
    let mut confirmation: Option<(Instant, bool)> = None;
    let mut code_enter_at: Option<Instant> = None;
    let mut fallback_shown = false;
    let mut last_url = None;
    let mut failure = None;
    let mut parsed_len = 0;
    let mut eof = false;
    loop {
        let was_eof = eof;
        if eof {
            std::thread::sleep(POLL_INTERVAL);
        } else {
            let received_bytes = &mut guard.diagnostics.received_bytes;
            let result = match receiver.recv_timeout(POLL_INTERVAL) {
                Ok(output) => record_output(&mut raw, output, received_bytes),
                Err(mpsc::RecvTimeoutError::Timeout) => Ok(false),
                Err(mpsc::RecvTimeoutError::Disconnected) => Err(FailureReason::OutputIncomplete),
            }.and_then(|end| {
                if end { Ok(true) } else { record_pending_output(&receiver, &mut raw, received_bytes) }
            });
            match result {
                Ok(end) => eof = end,
                Err(reason) => { failure = Some(reason); break; }
            }
        }
        if control.cancelled.load(Ordering::SeqCst) {
            failure = Some(FailureReason::Status(CaptureFailure::Cancelled));
            break;
        }
        if started.elapsed() >= options.timeout {
            if candidate.is_none() && confirmation.is_none() {
                // Keep the rejection from the evaluated screen before processing the newest batch.
                let counts = ScreenCounts::from_screen(&guard.screen);
                if counts.heading_rows > 0 && counts.value_rows > 0 {
                    guard.diagnostics.timeout_rejection = Some(screen_rejection);
                }
            }
            failure = Some(FailureReason::Status(CaptureFailure::Timeout));
            break;
        }
        let mut code_notice = None;
        if raw.0.len() != parsed_len || (eof && !was_eof) {
            parsed_len = raw.0.len();
            let plain = strip_controls(raw.as_slice());
            if update_screen_and_check_error(&mut guard.screen, raw.as_slice(), &plain, eof) {
                failure = Some(FailureReason::Status(CaptureFailure::CliError));
                break;
            }
            if confirmation.is_none() {
                match screen_candidate(&guard.screen) {
                    Ok((heading, token)) => {
                        let was_waiting = candidate.is_none();
                        if candidate.as_ref().is_none_or(|previous| previous.heading != heading
                            || previous.token.as_slice() != token.as_slice())
                        {
                            candidate = Some(ProvisionalCandidate { heading, token, since: Instant::now() });
                        }
                        if was_waiting {
                            guard.publish(SetupTokenState::Confirming, None, None);
                        }
                    }
                    Err(rejection) => {
                        screen_rejection = rejection;
                        let url_changed = authorization_url(plain.as_slice())
                            .filter(|url| last_url.as_ref() != Some(url));
                        if let Some(url) = &url_changed { last_url = Some(url.clone()); }
                        if candidate.take().is_some() {
                            fallback_shown = true;
                            code_notice = Some((SetupTokenState::CodeAvailable, Some("code_reopened")));
                        } else if url_changed.is_some() {
                            let state = if fallback_shown { SetupTokenState::CodeAvailable } else { SetupTokenState::WaitingBrowser };
                            code_notice = Some((state, None));
                        }
                    }
                }
            }
        }
        match pty.finished(confirmation.is_some_and(|(_, sent)| !sent), &mut guard.diagnostics) {
            Ok(Some(status)) => {
                if !status.success() { failure = Some(FailureReason::from_child_exit(&status)); }
                break;
            }
            Ok(None) => {}
            Err(reason) => { failure = Some(reason); break; }
        }
        let pending_escape = guard.screen.has_pending_escape();
        if let Some((at, sent)) = confirmation {
            if at.elapsed() >= options.confirm_exit_grace {
                if !sent { failure = Some(FailureReason::ConfirmationFailed); }
                break;
            }
        } else if let Some(provisional) = &candidate {
            if !pending_escape && provisional.since.elapsed() >= options.token_exit_grace {
                if !eof {
                    let _ = registry.close_input(id);
                }
                let sent = !eof && pty.writer.write_all(b"\r").is_ok();
                if sent {
                    drop(control.codes.try_recv());
                }
                let at = Instant::now();
                let sent = sent && pty.writer.flush().is_ok();
                guard.diagnostics.enter_sent = sent;
                confirmation = Some((at, sent));
                candidate = None;
            }
        } else if eof {
            failure = Some(FailureReason::Screen(screen_rejection));
            break;
        } else if let Some(at) = code_enter_at {
            if Instant::now() >= at && !pending_escape {
                code_enter_at = None;
                if pty.writer.write_all(b"\r").and_then(|_| pty.writer.flush()).is_err() {
                    failure = Some(FailureReason::CodeWriteFailed); break;
                }
            }
        } else if !pending_escape {
            if let Ok(mut code) = control.codes.try_recv() {
                let sent = pty.writer.write_all(code.as_slice()).and_then(|_| pty.writer.flush());
                code.wipe();
                if sent.is_err() { failure = Some(FailureReason::CodeWriteFailed); break; }
                code_enter_at = Some(Instant::now() + Duration::from_millis(150));
            }
        }

        // Input queued by a notice is handled after polling the next output batch.
        if let Some((state, reason)) = code_notice {
            guard.publish(state, last_url.clone(), reason);
        }
        if !fallback_shown && candidate.is_none() && confirmation.is_none() && !eof
            && started.elapsed() >= options.fallback_after
        {
            fallback_shown = true;
            guard.publish(SetupTokenState::CodeAvailable, last_url.clone(), None);
        }
    }
    let _ = registry.close_input(id);
    drop(control.codes.try_recv());
    if failure.is_none() {
        match pty.child.try_wait() {
            Ok(Some(status)) => {
                guard.diagnostics.record_child_status(&status);
                if !status.success() { failure = Some(FailureReason::from_child_exit(&status)); }
            }
            Err(_) => failure = Some(FailureReason::ChildWaitFailed),
            _ => {}
        }
    }
    let stopped = pty.stop();
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
    let drain = if eof || failure.is_some() || !stopped {
        Ok(())
    } else {
        drain_output(&receiver, &mut raw, drain_deadline.saturating_duration_since(Instant::now()),
            &mut guard.diagnostics.received_bytes)
    };
    drop(receiver); // Wipe queued chunks and switch the worker to discarding.
    #[cfg(windows)]
    {
        let completion = windows_job::finish_output(
            reader_thread, close_thread, stop_reading, drain_deadline, close_deadline,
            #[cfg(test)]
            output_hooks,
        );
        if !completion.complete() && stopped {
            failure.get_or_insert(drain.err().unwrap_or(FailureReason::OutputIncomplete));
        }
    }
    #[cfg(not(windows))]
    {
        drop(close_thread);
        stop_reading.store(true, Ordering::SeqCst);
        if reader_thread.is_finished() { let _ = reader_thread.join(); }
    }
    let output = if stopped {
        failure.map_or(drain, Err).map_err(TerminalFailure::Reason)
    } else {
        Err(TerminalFailure::StopUnconfirmed(failure))
    };
    let captured = match output {
        Ok(()) => {
            guard.screen = Screen::default();
            capture_complete(&raw, &mut guard.screen).map_err(TerminalFailure::Reason)
        }
        Err(reason) => {
            // Account for the last accepted bytes even when the loop stopped
            // before parsing them. Only an observed EOF ends the parser input.
            if eof {
                guard.screen.finish(raw.as_slice(), |_, _| false);
            } else {
                guard.screen.update(raw.as_slice(), |_, _| false);
            }
            Err(reason)
        }
    };
    raw.wipe();
    let (failure, status) = match captured {
        Err(reason) => (Some(reason), None),
        Ok(mut token) => {
            guard.publish(SetupTokenState::CheckingOwner, None, None);
            let result = if control.cancelled.load(Ordering::SeqCst) { Err("cancelled".to_string()) } else {
                // Use the same owner lookup as manual registration; inspect
                // cancellation after network lookup, before any local write.
                let value = std::str::from_utf8(token.as_slice()).expect("validated ASCII");
                let checked = check_owner(value);
                registry.commit(id, || launch_tokens::save_with_outcome(base, secrets, &initial.profile_id, value, |_| checked))
            };
            token.wipe();
            let (failure, status) = match result {
                Ok(SaveOutcome::Saved(status)) => (None, Some(status)),
                Ok(SaveOutcome::MismatchRecorded(status)) => (Some(CaptureFailure::OwnerMismatch), Some(status)),
                Err(error) if error == "cancelled" => (Some(CaptureFailure::Cancelled), None),
                Err(error) if error == ERR_LAUNCH_TOKEN_OWNER_MISMATCH => (Some(CaptureFailure::OwnerMismatch), None),
                Err(error) if error == ERR_LAUNCH_TOKEN_REPLACEMENT_UNVERIFIED =>
                    (Some(CaptureFailure::ReplacementUnverified), None),
                Err(_) => (Some(CaptureFailure::SaveFailed), None),
            };
            (failure.map(TerminalFailure::status), status)
        }
    };
    // Terminal events are sent after process termination and staging cleanup.
    drop(staging);
    guard.finish(failure, status);
    RunAudit { child_stopped: stopped, wiped_buffer: std::mem::take(&mut raw.0) }
}

#[cfg(test)]
#[path = "setup_token_tests.rs"]
mod tests;
