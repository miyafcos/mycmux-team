use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(200);

/// Owns recursive filesystem watchers for each pinned root. Emits
/// `fs_changed { path }` for the parent directory of any filesystem event it
/// observes, throttled so that a burst of writes to the same directory
/// collapses into a single frontend refresh.
pub struct FsWatcher {
    watchers: Arc<Mutex<HashMap<PathBuf, RecommendedWatcher>>>,
    last_emit: Arc<Mutex<HashMap<PathBuf, Instant>>>,
    app_handle: AppHandle,
}

impl FsWatcher {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
            last_emit: Arc::new(Mutex::new(HashMap::new())),
            app_handle,
        }
    }

    pub fn watch(&self, root: PathBuf) -> Result<(), String> {
        let mut watchers = self.watchers.lock().map_err(|e| e.to_string())?;
        if watchers.contains_key(&root) {
            return Ok(());
        }

        let handle = self.app_handle.clone();
        let last_emit = self.last_emit.clone();

        let mut w =
            notify::recommended_watcher(move |res: Result<Event, notify::Error>| match res {
                Ok(event) => emit_changes(&handle, &last_emit, &event),
                Err(err) => eprintln!("[fs_watcher] notify error: {err}"),
            })
            .map_err(|e| format!("failed to create watcher: {e}"))?;

        w.watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("failed to watch {:?}: {e}", root))?;

        watchers.insert(root, w);
        Ok(())
    }

    pub fn unwatch(&self, root: &Path) -> Result<(), String> {
        let mut watchers = self.watchers.lock().map_err(|e| e.to_string())?;
        if let Some(mut w) = watchers.remove(root) {
            // Ignore unwatch errors — the watcher is being dropped anyway.
            let _ = w.unwatch(root);
        }
        Ok(())
    }
}

fn emit_changes(
    handle: &AppHandle,
    last_emit: &Arc<Mutex<HashMap<PathBuf, Instant>>>,
    event: &Event,
) {
    let now = Instant::now();
    let mut emitted: Vec<PathBuf> = Vec::new();
    let mut last = match last_emit.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    for path in &event.paths {
        let parent = match path.parent() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        if emitted.contains(&parent) {
            continue;
        }
        let should_emit = match last.get(&parent) {
            Some(t) => now.duration_since(*t) >= DEBOUNCE,
            None => true,
        };
        if !should_emit {
            continue;
        }
        last.insert(parent.clone(), now);
        emitted.push(parent.clone());
        let _ = handle.emit(
            "fs_changed",
            json!({ "path": parent.to_string_lossy().to_string() }),
        );
    }
}
