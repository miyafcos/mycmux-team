//! Quitting with every window's work written down first.
//!
//! macOS never asked the app before: ⌘Q goes straight to
//! `applicationWillTerminate`, so the only state that survived was whatever the
//! debounced autosave had already written, and anything changed in the last
//! half second was lost (measured on a Mac mini, 2026-09-17: a workspace
//! renamed just before ⌘Q came back under its old name).
//!
//! So the Quit item runs this instead: every window publishes what it holds,
//! the window that owns `data.json` writes the union, and only then does the
//! app exit. Each step is bounded, so a wedged window delays the quit by a
//! couple of seconds rather than preventing it.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

/// Sent to every window: publish your workspaces now and stop autosaving.
pub const QUIT_PREPARE_EVENT: &str = "mycmux://prepare-quit";
/// Sent once the peers have published: write `data.json` now.
pub const QUIT_SAVE_EVENT: &str = "mycmux://save-and-quit";

const PREPARE_TIMEOUT: Duration = Duration::from_millis(1_200);
const SAVE_TIMEOUT: Duration = Duration::from_millis(2_500);
const POLL: Duration = Duration::from_millis(20);

#[derive(Default)]
pub struct QuitCoordinator {
    running: AtomicBool,
    prepared: Mutex<HashSet<String>>,
    saved: AtomicBool,
}

impl QuitCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    fn start(&self) -> bool {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn note_prepared(&self, label: &str) {
        self.prepared
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(label.to_string());
    }

    fn all_prepared(&self, expected: &HashSet<String>) -> bool {
        let prepared = self
            .prepared
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        expected.iter().all(|label| prepared.contains(label))
    }

    fn note_saved(&self) {
        self.saved.store(true, Ordering::SeqCst);
    }

    fn has_saved(&self) -> bool {
        self.saved.load(Ordering::SeqCst)
    }
}

/// Answered by every window once its fragment is published.
#[tauri::command(async)]
pub fn quit_prepared(window: tauri::Window, state: State<'_, QuitCoordinator>) {
    state.note_prepared(window.label());
}

/// Answered by the window that owns `data.json` once the file is written.
#[tauri::command(async)]
pub fn quit_saved(state: State<'_, QuitCoordinator>) {
    state.note_saved();
}

fn wait_until(deadline: Instant, mut done: impl FnMut() -> bool) -> bool {
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL);
    }
}

/// Start the quit. Returns immediately; the app exits from a worker thread once
/// the windows have answered or their time is up.
pub fn begin_quit(app: &AppHandle) {
    let Some(state) = app.try_state::<QuitCoordinator>() else {
        app.exit(0);
        return;
    };
    if !state.start() {
        return; // A quit is already under way.
    }
    let labels: HashSet<String> = app.windows().keys().cloned().collect();
    if labels.is_empty() {
        app.exit(0);
        return;
    }
    let _ = app.emit(QUIT_PREPARE_EVENT, ());
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<QuitCoordinator>();
        let prepared = wait_until(Instant::now() + PREPARE_TIMEOUT, || {
            state.all_prepared(&labels)
        });
        let _ = app.emit(QUIT_SAVE_EVENT, ());
        let saved = wait_until(Instant::now() + SAVE_TIMEOUT, || state.has_saved());
        crate::diag::log(&format!(
            "[quit] windows={} prepared={prepared} saved={saved}",
            labels.len()
        ));
        app.exit(0);
    });
}

/// Last-chance save for the exits that never reach a window: the Dock's Quit,
/// a logout, or a coordinated quit whose windows ran out of time.
///
/// Additive on purpose. It fills in workspaces the file is missing but some
/// window still holds, and leaves everything else alone: a save that is
/// seconds old is a far better outcome than replacing it with a snapshot
/// assembled from fragments that may themselves be a moment behind.
pub fn fill_in_unsaved_workspaces(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut held: Vec<crate::db::storage::WorkspaceConfig> = Vec::new();
    for fragment in state.window_registry.fragments() {
        for workspace in fragment.workspaces {
            let Some(id) = crate::window_registry::workspace_config_id(&workspace) else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            match serde_json::from_value(workspace) {
                Ok(config) => held.push(config),
                Err(error) => {
                    crate::diag_warn!("quit", "could not read a published workspace: {error}")
                }
            }
        }
    }
    if held.is_empty() {
        return;
    }
    let result = crate::db::storage::update(app, move |disk| {
        let known: HashSet<String> = disk
            .workspaces
            .iter()
            .map(|workspace| workspace.id.clone())
            .collect();
        let missing: Vec<_> = held
            .into_iter()
            .filter(|workspace| !known.contains(&workspace.id))
            .collect();
        if missing.is_empty() {
            return;
        }
        crate::diag::log(&format!(
            "[quit] wrote {} workspace(s) the last save had not reached",
            missing.len()
        ));
        disk.workspaces.extend(missing);
    });
    if let Err(error) = result {
        crate::diag_warn!("quit", "last-chance save failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_quit_request_runs() {
        let coordinator = QuitCoordinator::new();
        assert!(coordinator.start());
        assert!(!coordinator.start());
    }

    #[test]
    fn every_open_window_has_to_answer() {
        let coordinator = QuitCoordinator::new();
        let expected = HashSet::from(["main".to_string(), "mycmux-w1".to_string()]);
        assert!(!coordinator.all_prepared(&expected));
        coordinator.note_prepared("main");
        assert!(!coordinator.all_prepared(&expected));
        coordinator.note_prepared("mycmux-w1");
        assert!(coordinator.all_prepared(&expected));
    }

    #[test]
    fn waiting_gives_up_at_the_deadline() {
        let started = Instant::now();
        assert!(!wait_until(started + Duration::from_millis(60), || false));
        assert!(started.elapsed() >= Duration::from_millis(60));
        assert!(wait_until(Instant::now() + Duration::from_secs(5), || true));
    }
}
