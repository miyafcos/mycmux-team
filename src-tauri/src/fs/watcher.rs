use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(200);
const EMIT_WINDOW: Duration = Duration::from_secs(1);
const MAX_EMITS_PER_WINDOW: usize = 20;
const LAST_EMIT_TTL: Duration = Duration::from_secs(5 * 60);
const DIAGNOSTIC_INTERVAL: Duration = Duration::from_secs(60);

/// Owns non-recursive filesystem watchers for directories opened by the frontend. Emits
/// `fs_changed { path }` for the parent directory of any filesystem event it
/// observes, throttled so that a burst of writes to the same directory
/// collapses into a single frontend refresh.
pub struct FsWatcher {
    watchers: Arc<Mutex<HashMap<PathBuf, RecommendedWatcher>>>,
    emit_state: Arc<Mutex<EmitState>>,
    app_handle: AppHandle,
}

struct EmitState {
    last_emit: HashMap<PathBuf, Instant>,
    recent_emits: VecDeque<Instant>,
    last_diagnostic: Option<Instant>,
    emitted: u64,
    debounced: u64,
    excluded: u64,
    rate_limited: u64,
}

impl FsWatcher {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
            emit_state: Arc::new(Mutex::new(EmitState {
                last_emit: HashMap::new(),
                recent_emits: VecDeque::new(),
                last_diagnostic: None,
                emitted: 0,
                debounced: 0,
                excluded: 0,
                rate_limited: 0,
            })),
            app_handle,
        }
    }

    pub fn watch(&self, root: PathBuf) -> Result<(), String> {
        let mut watchers = self.watchers.lock().map_err(|e| e.to_string())?;
        if watchers.contains_key(&root) {
            return Ok(());
        }

        let handle = self.app_handle.clone();
        let emit_state = self.emit_state.clone();

        let mut w =
            notify::recommended_watcher(move |res: Result<Event, notify::Error>| match res {
                Ok(event) => emit_changes(&handle, &emit_state, &event),
                Err(err) => eprintln!("[fs_watcher] notify error: {err}"),
            })
            .map_err(|e| format!("failed to create watcher: {e}"))?;

        w.watch(&root, RecursiveMode::NonRecursive)
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

fn emit_changes(handle: &AppHandle, emit_state: &Arc<Mutex<EmitState>>, event: &Event) {
    let now = Instant::now();
    let mut paths_to_emit: Vec<PathBuf> = Vec::new();
    let mut seen_parents = HashSet::new();
    let diagnostic = {
        let mut state = match emit_state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        state
            .last_emit
            .retain(|_, emitted_at| now.duration_since(*emitted_at) < LAST_EMIT_TTL);
        while matches!(state.recent_emits.front(), Some(emitted_at) if now.duration_since(*emitted_at) >= EMIT_WINDOW)
        {
            state.recent_emits.pop_front();
        }

        for path in &event.paths {
            if is_excluded_path(path) {
                state.excluded += 1;
                continue;
            }
            let parent = match path.parent() {
                Some(parent) => parent.to_path_buf(),
                None => continue,
            };
            if !seen_parents.insert(parent.clone()) {
                continue;
            }
            if state
                .last_emit
                .get(&parent)
                .is_some_and(|emitted_at| now.duration_since(*emitted_at) < DEBOUNCE)
            {
                state.debounced += 1;
                continue;
            }
            if state.recent_emits.len() >= MAX_EMITS_PER_WINDOW {
                state.rate_limited += 1;
                continue;
            }
            state.last_emit.insert(parent.clone(), now);
            state.recent_emits.push_back(now);
            paths_to_emit.push(parent);
        }

        match state.last_diagnostic {
            Some(last) if now.duration_since(last) >= DIAGNOSTIC_INTERVAL => {
                state.last_diagnostic = Some(now);
                let diagnostic = (
                    state.emitted,
                    state.debounced,
                    state.excluded,
                    state.rate_limited,
                );
                state.emitted = 0;
                state.debounced = 0;
                state.excluded = 0;
                state.rate_limited = 0;
                Some(diagnostic)
            }
            Some(_) => None,
            None => {
                state.last_diagnostic = Some(now);
                None
            }
        }
    };

    for parent in paths_to_emit {
        if handle
            .emit(
                "fs_changed",
                json!({ "path": parent.to_string_lossy().to_string() }),
            )
            .is_ok()
        {
            if let Ok(mut state) = emit_state.lock() {
                state.emitted += 1;
            }
        }
    }

    if let Some((emitted, debounced, excluded, rate_limited)) = diagnostic {
        eprintln!(
            "[mycmux-diag fs_watcher] emitted={emitted} debounced={debounced} excluded={excluded} rate_limited={rate_limited}"
        );
    }
}

fn is_excluded_path(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        matches!(
            name.to_ascii_lowercase().as_str(),
            "node_modules" | ".git" | "appdata" | ".codex" | ".mycmux"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::is_excluded_path;
    use std::path::Path;

    #[test]
    fn excludes_noisy_path_components() {
        for path in [
            "C:/work/node_modules/package/index.js",
            "C:/work/.git/index",
            "C:/Users/example/AppData/Local/cache",
            "C:/Users/example/.codex/session.jsonl",
            "C:/Users/example/.mycmux/data.json",
        ] {
            assert!(is_excluded_path(Path::new(path)), "{path}");
        }
        assert!(!is_excluded_path(Path::new("C:/work/src/main.rs")));
    }
}
