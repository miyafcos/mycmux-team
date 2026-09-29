//! File-open requests from the shell, Finder, and the authenticated local socket.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const OPEN_PATHS_EVENT: &str = "mycmux://open-paths";

#[derive(Default)]
pub struct PendingOpenPaths(Mutex<Vec<String>>);

impl PendingOpenPaths {
    pub fn with_paths(paths: Vec<PathBuf>) -> Self {
        Self(Mutex::new(
            paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        ))
    }

    fn push(&self, paths: Vec<String>) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .extend(paths);
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|error| error.into_inner()))
    }
}

#[tauri::command]
pub async fn take_pending_open_paths(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(app.state::<PendingOpenPaths>().take())
}

pub fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    let mut args = args.into_iter();
    let _program = args.next();
    let mut paths = Vec::new();
    while let Some(arg) = args.next() {
        if arg == "--profile" {
            let _ = args.next();
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        let path = PathBuf::from(arg);
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        if path.is_file() {
            paths.push(path);
        }
    }
    paths
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RejectedPath {
    path: String,
    reason: &'static str,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct OpenPathsResult {
    accepted: Vec<String>,
    rejected: Vec<RejectedPath>,
}

pub fn classify_open_paths(paths: &[String]) -> OpenPathsResult {
    let mut result = OpenPathsResult {
        accepted: Vec::new(),
        rejected: Vec::new(),
    };
    for value in paths {
        let path = Path::new(value);
        let reason = if !path.is_absolute() {
            Some("path must be absolute")
        } else if !path.exists() {
            Some("file does not exist")
        } else if !path.is_file() {
            Some("path is not a file")
        } else if !crate::commands::artifact::is_previewable_artifact(path)
            || crate::commands::artifact::artifact_source_kind(path).is_none()
        {
            Some("unsupported file type")
        } else {
            None
        };
        match reason {
            Some(reason) => result.rejected.push(RejectedPath {
                path: value.clone(),
                reason,
            }),
            None => result.accepted.push(value.clone()),
        }
    }
    result
}

pub fn queue_open_paths(app: &AppHandle, paths: &[String]) -> OpenPathsResult {
    let result = classify_open_paths(paths);
    if !result.accepted.is_empty() {
        app.state::<PendingOpenPaths>()
            .push(result.accepted.clone());
        crate::commands::window::show_main_window(app);
        let _ = app.emit_to("main", OPEN_PATHS_EVENT, ());
    }
    result
}

pub fn activate(app: &AppHandle) {
    crate::commands::window::show_main_window(app);
}

#[cfg(target_os = "macos")]
pub fn path_from_file_url(url: &tauri::Url) -> Option<PathBuf> {
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

#[cfg(target_os = "macos")]
pub fn queue_opened_urls(app: &AppHandle, urls: &[tauri::Url]) {
    let paths: Vec<String> = urls
        .iter()
        .filter_map(path_from_file_url)
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let _ = queue_open_paths(app, &paths);
}

/// The second process talks only to the profile-specific discovery directory.
/// A stale port, a not-yet-listening socket, and a frontend startup race all
/// share the same short deadline; none starts another app window.
pub fn forward_to_running_instance(paths: &[PathBuf]) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{SocketAddr, TcpStream};

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
        let _ = AllowSetForegroundWindow(ASFW_ANY);
    }

    let runtime_dir = crate::test_profile::runtime_dir()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let attempt = (|| -> Result<(), String> {
            let port = std::fs::read_to_string(runtime_dir.join("mycmux.port"))
                .map_err(|error| error.to_string())?
                .trim()
                .parse::<u16>()
                .map_err(|error| error.to_string())?;
            let token = std::fs::read_to_string(runtime_dir.join("mycmux.token"))
                .map_err(|error| error.to_string())?;
            let address = SocketAddr::from(([127, 0, 0, 1], port));
            let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500))
                .map_err(|error| error.to_string())?;
            stream
                .set_read_timeout(Some(Duration::from_millis(800)))
                .map_err(|error| error.to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_millis(800)))
                .map_err(|error| error.to_string())?;
            let request = if paths.is_empty() {
                serde_json::json!({ "cmd": "app.activate", "args": {}, "token": token.trim() })
            } else {
                let paths: Vec<String> = paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                serde_json::json!({ "cmd": "app.open_paths", "args": { "paths": paths }, "token": token.trim() })
            };
            writeln!(stream, "{request}").map_err(|error| error.to_string())?;
            let mut reply = String::new();
            BufReader::new(stream)
                .read_line(&mut reply)
                .map_err(|error| error.to_string())?;
            let response: serde_json::Value =
                serde_json::from_str(&reply).map_err(|error| error.to_string())?;
            if let Some(error) = response.get("error").and_then(|value| value.as_str()) {
                return Err(error.to_string());
            }
            if response
                .get("result")
                .is_none_or(serde_json::Value::is_null)
            {
                return Err("socket response has no result".into());
            }
            Ok(())
        })();
        let error = match attempt {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        if Instant::now() >= deadline {
            return Err(error);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_existing_paths_without_profile_or_flags() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        std::fs::write(&file, "# note").unwrap();
        assert_eq!(
            paths_from_args(
                [
                    "mycmux".into(),
                    "--profile".into(),
                    "test".into(),
                    "-v".into(),
                    "note.md".into(),
                    "missing.md".into(),
                ],
                dir.path()
            ),
            vec![file]
        );
    }

    #[test]
    fn pending_paths_are_taken_once() {
        let pending = PendingOpenPaths::with_paths(vec![PathBuf::from("first.md")]);
        pending.push(vec!["second.html".into()]);
        assert_eq!(pending.take(), vec!["first.md", "second.html"]);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn classifies_rejected_paths_with_reasons() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("note.md");
        let bad = dir.path().join("archive.zip");
        std::fs::write(&good, "# note").unwrap();
        std::fs::write(&bad, "zip").unwrap();
        let result = classify_open_paths(&[
            good.to_string_lossy().into_owned(),
            "relative.md".into(),
            dir.path()
                .join("missing.html")
                .to_string_lossy()
                .into_owned(),
            dir.path().to_string_lossy().into_owned(),
            bad.to_string_lossy().into_owned(),
        ]);
        assert_eq!(result.accepted, vec![good.to_string_lossy().into_owned()]);
        assert_eq!(
            result
                .rejected
                .iter()
                .map(|item| item.reason)
                .collect::<Vec<_>>(),
            vec![
                "path must be absolute",
                "file does not exist",
                "path is not a file",
                "unsupported file type"
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn file_urls_decode_spaces_and_percent_encoded_names() {
        let url = tauri::Url::parse("file:///tmp/a%20b/%E6%97%A5%E6%9C%AC.md").unwrap();
        assert_eq!(
            path_from_file_url(&url),
            Some(PathBuf::from("/tmp/a b/\u{65e5}\u{672c}.md"))
        );
        assert!(
            path_from_file_url(&tauri::Url::parse("https://example.com/a.md").unwrap()).is_none()
        );
    }
}
