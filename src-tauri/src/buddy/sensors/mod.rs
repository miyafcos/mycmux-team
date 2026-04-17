use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Runtime};
use tokio::sync::mpsc;

use super::signal::{emit_signal_event, SignalEvent};
use super::BUDDY_ENABLED;

pub mod claude_tail;
pub mod codex_tail;

#[derive(Debug, Default)]
struct JsonlTailState {
    offset: u64,
    pending_fragment: String,
}

pub fn spawn_all<R: Runtime + 'static>(app: AppHandle<R>) {
    claude_tail::spawn(app.clone());
    codex_tail::spawn(app);
}

pub(super) fn spawn_jsonl_tail<R, F>(
    app: AppHandle<R>,
    label: &'static str,
    path: PathBuf,
    parser: F,
) where
    R: Runtime + 'static,
    F: Fn(String, Value) -> SignalEvent + Send + Sync + Copy + 'static,
{
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_jsonl_tail(app, label, path, parser).await {
            eprintln!("[buddy][{label}] watcher terminated: {error}");
        }
    });
}

pub(super) fn user_home_dir() -> PathBuf {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        return PathBuf::from(user_profile);
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home);
    }
    PathBuf::from(".")
}

async fn run_jsonl_tail<R, F>(
    app: AppHandle<R>,
    label: &'static str,
    path: PathBuf,
    parser: F,
) -> notify::Result<()>
where
    R: Runtime + 'static,
    F: Fn(String, Value) -> SignalEvent + Send + Sync + Copy + 'static,
{
    let watch_root = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let target_name = path.file_name().map(|name| name.to_os_string());
    let (tx, mut rx) = mpsc::channel(64);
    let mut watcher = RecommendedWatcher::new(
        move |result| {
            let _ = tx.blocking_send(result);
        },
        Config::default(),
    )?;

    watcher.watch(&watch_root, RecursiveMode::NonRecursive)?;

    let mut state = JsonlTailState {
        offset: current_file_len(&path),
        pending_fragment: String::new(),
    };

    eprintln!("[buddy][{label}] watching {}", path.display());

    while let Some(result) = rx.recv().await {
        if !BUDDY_ENABLED.load(Ordering::Relaxed) {
            continue;
        }

        match result {
            Ok(event) if is_target_event(&event, target_name.as_ref()) => {
                read_new_lines(&path, &mut state, |line| {
                    match serde_json::from_str::<Value>(&line) {
                        Ok(value) => {
                            let signal = parser(line, value);
                            emit_signal_event(&app, &signal);
                        }
                        Err(error) => {
                            eprintln!("[buddy][{label}] invalid json line: {error}");
                        }
                    }
                });
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!("[buddy][{label}] notify error: {error}");
            }
        }
    }

    Ok(())
}

fn current_file_len(path: &Path) -> u64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn is_target_event(event: &Event, target_name: Option<&std::ffi::OsString>) -> bool {
    let Some(target_name) = target_name else {
        return false;
    };
    event
        .paths
        .iter()
        .filter_map(|path| path.file_name())
        .any(|name| name == target_name)
}

fn read_new_lines<F>(path: &Path, state: &mut JsonlTailState, mut on_line: F)
where
    F: FnMut(String),
{
    let file_len = current_file_len(path);
    if file_len == 0 {
        state.offset = 0;
        state.pending_fragment.clear();
        return;
    }

    if file_len < state.offset {
        state.offset = 0;
        state.pending_fragment.clear();
    }

    if file_len == state.offset {
        return;
    }

    let Ok(mut file) = File::open(path) else {
        return;
    };

    if file.seek(SeekFrom::Start(state.offset)).is_err() {
        return;
    }

    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return;
    }

    state.offset = file_len;

    let chunk = String::from_utf8_lossy(&buffer);
    let mut merged = std::mem::take(&mut state.pending_fragment);
    merged.push_str(&chunk);
    let ends_with_newline = merged.ends_with('\n') || merged.ends_with('\r');
    let mut lines = merged.lines().map(str::to_string).collect::<Vec<_>>();

    if !ends_with_newline {
        if let Some(last) = lines.pop() {
            state.pending_fragment = last;
        }
    }

    for line in lines {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            on_line(trimmed.to_string());
        }
    }
}
