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

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

/// Sent to every window: publish your workspaces now and stop autosaving.
pub const QUIT_PREPARE_EVENT: &str = "mycmux://prepare-quit";
/// Sent after the preparation phase: write the layout the leader has now.
pub const QUIT_SAVE_EVENT: &str = "mycmux://save-and-quit";

const PREPARE_TIMEOUT: Duration = Duration::from_millis(1_200);
const SAVE_TIMEOUT: Duration = Duration::from_millis(2_500);
const POLL: Duration = Duration::from_millis(20);

#[derive(Default)]
pub struct QuitCoordinator {
    running: AtomicBool,
    prepared: Mutex<HashMap<String, bool>>,
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

    fn note_prepared(&self, label: &str, fragment_published: bool) {
        self.prepared
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(label.to_string(), fragment_published);
    }

    fn all_prepared(&self, expected: &HashSet<String>) -> bool {
        let prepared = self
            .prepared
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        expected.iter().all(|label| prepared.contains_key(label))
    }

    fn all_fragments_published(&self, expected: &HashSet<String>) -> bool {
        let prepared = self
            .prepared
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        expected.iter().all(|label| prepared.get(label) == Some(&true))
    }

    fn note_saved(&self) {
        self.saved.store(true, Ordering::SeqCst);
    }

    fn has_saved(&self) -> bool {
        self.saved.load(Ordering::SeqCst)
    }
}

/// Answered by every window after its attempt to publish a fresh fragment.
#[tauri::command(async)]
pub async fn quit_prepared(
    window: tauri::Window, state: State<'_, QuitCoordinator>, fragment_published: bool,
) -> Result<(), String> {
    state.note_prepared(window.label(), fragment_published);
    Ok(())
}

/// Answered by the window that owns `data.json` once the file is written.
#[tauri::command(async)]
pub async fn quit_saved(state: State<'_, QuitCoordinator>) -> Result<(), String> {
    state.note_saved();
    crate::perf_timeline::mark("quit.saved.ack", None);
    Ok(())
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

fn finish_quit(fragments_published: bool, save: impl FnOnce() -> bool, record: impl FnOnce()) -> bool {
    let saved = save();
    if fragments_published && saved {
        record();
    }
    saved
}

pub(crate) fn is_quitting(app: &AppHandle) -> bool {
    app.try_state::<QuitCoordinator>()
        .is_some_and(|state| state.running.load(Ordering::SeqCst))
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
        let published = prepared && state.all_fragments_published(&labels);
        let saved = finish_quit(
            published,
            || {
                let _ = app.emit(QUIT_SAVE_EVENT, ());
                wait_until(Instant::now() + SAVE_TIMEOUT, || state.has_saved())
            },
            || crate::db::storage::record_coordinated_quit(&app),
        );
        crate::diag::log(&format!(
            "[quit] windows={} prepared={prepared} published={published} saved={saved}",
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
pub fn fill_in_unsaved_workspaces(app: &AppHandle, deadline: Instant) {
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
    let result = crate::db::storage::update_for_shutdown(app, deadline, move |disk| {
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
        coordinator.note_prepared("main", true);
        assert!(!coordinator.all_prepared(&expected));
        coordinator.note_prepared("mycmux-w1", true);
        assert!(coordinator.all_prepared(&expected));
        let mut recorded = false;
        assert!(!finish_quit(coordinator.all_fragments_published(&expected), || false, || recorded = true));
        assert!(!recorded);
        assert!(finish_quit(coordinator.all_fragments_published(&expected), || true, || recorded = true));
        assert!(recorded);
    }

    #[test]
    fn a_child_that_did_not_publish_prevents_a_coordinated_quit_marker() {
        let coordinator = QuitCoordinator::new();
        let expected = HashSet::from(["main".to_string(), "mycmux-w1".to_string()]);
        coordinator.note_prepared("main", true);
        coordinator.note_prepared("mycmux-w1", false);
        assert!(coordinator.all_prepared(&expected));

        let mut saved_count = 0;
        let mut recorded = false;
        let fragment_published = coordinator.all_fragments_published(&expected);
        let saved = finish_quit(fragment_published, || {
            saved_count += 1;
            true
        }, || recorded = true);

        assert!(!recorded, "a reply without a fresh fragment cannot mark coordinated-quit");
        assert_eq!(saved_count, 1, "the leader must still save the layout it has");
        assert!(saved);
    }

    #[test]
    fn a_prepare_timeout_still_asks_the_leader_to_save() {
        let coordinator = QuitCoordinator::new();
        let expected = HashSet::from(["main".to_string(), "mycmux-w1".to_string()]);
        coordinator.note_prepared("main", true);
        let prepared = wait_until(Instant::now(), || coordinator.all_prepared(&expected));
        assert!(!prepared);
        coordinator.note_prepared("mycmux-w1", true); // A reply just after the deadline.

        let mut saved_count = 0;
        let mut recorded = false;
        let published = prepared && coordinator.all_fragments_published(&expected);
        let saved = finish_quit(published, || {
            saved_count += 1;
            true
        }, || recorded = true);

        assert!(!recorded);
        assert_eq!(saved_count, 1, "the leader must save after a preparation timeout");
        assert!(saved);
    }

    #[test]
    fn waiting_gives_up_at_the_deadline() {
        let started = Instant::now();
        assert!(!wait_until(started + Duration::from_millis(60), || false));
        assert!(started.elapsed() >= Duration::from_millis(60));
        assert!(wait_until(Instant::now() + Duration::from_secs(5), || true));
    }
}
