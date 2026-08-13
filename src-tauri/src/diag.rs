use chrono::Local;
use std::any::Any;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

const MAX_LOG_BYTES: u64 = 1024 * 1024;
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Append one already-formatted line to `~/.mycmux/diag.log`.
///
/// Every write goes through `WRITE_LOCK`, so concurrent callers (Tauri command
/// threads, tokio tasks, the PTY writer threads) cannot interleave partial
/// lines. A poisoned lock is recovered rather than propagated: diagnostics must
/// never take the app down.
pub fn log(line: &str) {
    if cfg!(test) {
        // Unit tests exercise error paths on purpose; they must not append to
        // the developer's real ~/.mycmux/diag.log. `log_to_home` stays testable.
        return;
    }
    let Ok(runtime_dir) = crate::test_profile::runtime_dir() else {
        return;
    };
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = log_to_dir(&runtime_dir, line);
}

/// Log a warning/error from `module`. Release builds have no console, so every
/// site that already `eprintln!`s a failure should also land here.
pub fn warn(module: &str, message: &str) {
    log(&format_module_line(module, message));
}

/// Pure formatting for [`warn`] so the tag layout is testable.
pub fn format_module_line(module: &str, message: &str) -> String {
    format!("[{module}] {message}")
}

/// Log from inside the panic hook.
///
/// Unlike [`log`] this never blocks on `WRITE_LOCK`: the panicking thread may
/// already hold it (a panic inside `log_to_home` would otherwise self-deadlock,
/// and a deadlocked panic hook hangs the process). Losing the lock only risks
/// an interleaved line; a single append-mode `writeln!` keeps that unlikely.
/// Any I/O failure is swallowed — the hook must not panic again.
pub fn log_panic(line: &str) {
    if cfg!(test) {
        return;
    }
    let Ok(runtime_dir) = crate::test_profile::runtime_dir() else {
        return;
    };
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.try_lock().ok();
    let _ = log_to_dir(&runtime_dir, line);
}

/// Render the panic payload as text. `panic!` payloads are `&str` or `String`
/// in practice; anything else degrades to a placeholder instead of panicking.
pub fn panic_payload_text(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Pure formatting for the panic hook's diag line (payload + location).
pub fn format_panic_report(payload: &str, location: Option<&str>) -> String {
    format_module_line(
        "panic",
        &format!("at {}: {payload}", location.unwrap_or("<unknown location>")),
    )
}

/// One-line "log to stderr **and** to diag.log" for error paths.
///
/// `crate::diag_warn!("remote", "Failed to bind {addr}: {e}")` prints
/// `[remote] Failed to bind ...` on stderr (dev builds) and appends the same
/// text with a timestamp to diag.log (release builds have no console).
/// Only use it on low-frequency paths — diag.log rotates at 1 MiB.
#[macro_export]
macro_rules! diag_warn {
    ($module:expr, $($arg:tt)*) => {{
        let message = format!($($arg)*);
        eprintln!("[{}] {}", $module, message);
        $crate::diag::warn($module, &message);
    }};
}

// Production writes through log_to_dir with the active runtime dir; tests
// exercise rotation via a temp "home" through this wrapper.
#[cfg(test)]
fn log_to_home(home: &Path, line: &str) -> io::Result<()> {
    log_to_dir(&home.join(".mycmux"), line)
}

fn log_to_dir(dir: &Path, line: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;

    let path = dir.join("diag.log");
    let rotated = dir.join("diag.log.1");
    if fs::metadata(&path)
        .map(|metadata| metadata.len() > MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::remove_file(&rotated);
        fs::rename(&path, &rotated)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(
        file,
        "{} {line}",
        Local::now().format("%Y-%m-%dT%H:%M:%S%:z")
    )
}

#[cfg(test)]
mod tests {
    use super::{
        format_module_line, format_panic_report, log_to_home, panic_payload_text, MAX_LOG_BYTES,
    };
    use std::fs;

    #[test]
    fn tags_module_lines_so_diag_log_says_where_the_failure_came_from() {
        assert_eq!(
            format_module_line("remote", "Failed to bind 0.0.0.0:7682"),
            "[remote] Failed to bind 0.0.0.0:7682"
        );
    }

    #[test]
    fn module_lines_are_written_with_a_timestamp_prefix() {
        let temp = tempfile::tempdir().unwrap();
        log_to_home(temp.path(), &format_module_line("storage", "save failed")).unwrap();

        let written = fs::read_to_string(temp.path().join(".mycmux").join("diag.log")).unwrap();
        let (timestamp, rest) = written.trim_end().split_once(' ').unwrap();
        assert_eq!(rest, "[storage] save failed");
        // 2026-08-09T12:34:56+09:00 — date, time and offset must all be present.
        assert!(timestamp.starts_with("20"), "{timestamp}");
        assert!(timestamp.contains('T'), "{timestamp}");
        assert_eq!(timestamp.matches(':').count(), 3, "{timestamp}");
    }

    #[test]
    fn panic_reports_carry_payload_and_location() {
        assert_eq!(
            format_panic_report("boom", Some("src/pty/session.rs:42:9")),
            "[panic] at src/pty/session.rs:42:9: boom"
        );
    }

    #[test]
    fn panic_reports_survive_a_missing_location() {
        assert_eq!(
            format_panic_report("boom", None),
            "[panic] at <unknown location>: boom"
        );
    }

    #[test]
    fn panic_payloads_are_read_from_both_str_and_string_forms() {
        let borrowed: Box<dyn std::any::Any + Send> = Box::new("static message");
        let owned: Box<dyn std::any::Any + Send> = Box::new(String::from("formatted message"));
        let opaque: Box<dyn std::any::Any + Send> = Box::new(7u8);

        assert_eq!(panic_payload_text(borrowed.as_ref()), "static message");
        assert_eq!(panic_payload_text(owned.as_ref()), "formatted message");
        assert_eq!(
            panic_payload_text(opaque.as_ref()),
            "<non-string panic payload>"
        );
    }

    #[test]
    fn a_real_panic_payload_round_trips_through_the_hook_formatter() {
        let caught = std::panic::catch_unwind(|| panic!("hook formatting {}", 1 + 1)).unwrap_err();
        assert_eq!(
            format_panic_report(&panic_payload_text(caught.as_ref()), Some("src/lib.rs:1:1")),
            "[panic] at src/lib.rs:1:1: hook formatting 2"
        );
    }

    #[test]
    fn rotates_an_oversized_log_without_touching_the_real_home() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(".mycmux");
        fs::create_dir_all(&dir).unwrap();
        let old_log = vec![b'a'; (MAX_LOG_BYTES + 1) as usize];
        fs::write(dir.join("diag.log"), &old_log).unwrap();
        fs::write(dir.join("diag.log.1"), b"older generation").unwrap();

        log_to_home(temp.path(), "fresh diagnostic").unwrap();

        assert_eq!(fs::read(dir.join("diag.log.1")).unwrap(), old_log);
        let fresh = fs::read_to_string(dir.join("diag.log")).unwrap();
        assert!(fresh.ends_with("fresh diagnostic\n"));
    }
}
