//! Commands backing the Phase 3b workspace tear-out.
//!
//! Design: `docs/plans/2026-08-09-multiwindow-tearout-design.md` (§State sync,
//! §Lifecycle, "Phase 3b").
//!
//! The move protocol never touches the PTY: the source window drops the
//! workspace from its store *without* `killSession`, the target window mounts
//! it and `create_session` takes the reattach branch
//! (`pty/manager.rs` — the pinned `return Ok(());` early-return). All this
//! layer does is hand the serialized workspaces from one webview to the other
//! and remember who owns what until the handover completes.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::window::{
    all_window_labels, resolve_child_window_label, reserve_child_window_label,
    restore_child_window_frame, spawn_child_window, spawn_child_window_with_restore, ResolvedChildWindow,
};
use crate::db::storage::{self, AppSettings};
use crate::window_registry::{
    workspace_config_ids, WindowAdoptPayload, WindowFragment,
    WINDOW_ADOPT_EVENT, WINDOW_REGISTRY_CHANGED_EVENT,
};
use crate::AppState;

fn emit_registry_changed(app: &AppHandle, revision: u64) {
    let _ = app.emit(WINDOW_REGISTRY_CHANGED_EVENT, revision);
}

fn emit_adopt(app: &AppHandle, payload: WindowAdoptPayload) {
    let target = payload.to_label.clone();
    if let Err(err) = app.emit_to(target.as_str(), WINDOW_ADOPT_EVENT, payload) {
        crate::diag_warn!(
            "window-registry",
            "failed to notify {target} about adopted workspaces: {err}"
        );
    }
}

/// Only a complete saved owner group uses the quiet restore path. Ordinary
/// live handovers retain their existing reveal/focus behavior.
fn saved_window_decoration(label: Option<&str>, workspaces: &[Value]) -> Option<bool> {
    let label = label?;
    if workspaces.is_empty() || !workspaces.iter().all(|workspace|
        workspace["window_group"]["label"].as_str() == Some(label)) { return None; }
    Some(workspaces[0]["window_group"]["decorated"].as_bool().unwrap_or(cfg!(target_os = "macos")))
}

fn workspaces_native_kind(workspaces: &[Value], decorated: Option<bool>) -> bool {
    workspaces.first().and_then(|workspace| workspace["window_group"]["native_tearout"].as_bool())
        .unwrap_or(cfg!(target_os = "macos") && decorated == Some(false))
}

/// Open a new window that will adopt `workspaces` on boot.
///
/// The caller (the source window) serializes the workspaces first and drops
/// them from its own store afterwards — see `tearOutWorkspaceToNewWindow` in
/// `src/lib/workspaceTearOut.ts`. Handing over the payload (rather than only
/// ids) is deliberate: a workspace created seconds ago may not be in any
/// published fragment yet, and looking it up there would tear out a stale — or
/// missing — copy.
///
/// Sync for the same reason as `open_child_window`: the body only touches
/// in-memory maps and posts the `WebviewWindowBuilder` to the main thread
/// (`tests/test_command_sync_contract.py`).
#[tauri::command]
pub fn open_workspace_window(
    _trusted: crate::ipc_caller::TrustedAppCaller,
    app: AppHandle,
    state: State<'_, AppState>,
    from_label: String,
    workspaces: Vec<Value>,
    label: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    deferred_adoption: Option<bool>,
    creation_id: Option<String>,
) -> Result<String, String> {
    if crate::commands::quit::is_quitting(&app) {
        return Err("Application is preparing to quit".into());
    }
    if workspaces.is_empty() {
        return Err("open_workspace_window requires at least one workspace".to_string());
    }
    let native = workspaces_native_kind(&workspaces, saved_window_decoration(label.as_deref(), &workspaces));
    let workspace_ids = workspace_config_ids(&workspaces);
    if workspace_ids.len() != workspaces.len() {
        return Err("every workspace handed to open_workspace_window needs an id".to_string());
    }

    let deferred = deferred_adoption.unwrap_or(false);
    if deferred && creation_id.as_ref().is_none_or(|id| id.is_empty() || id.len() > 128) {
        return Err("A deferred workspace window requires a creation request ID".into());
    }
    let restoring = saved_window_decoration(label.as_deref(), &workspaces);
    // Only the saved Windows native branch has the new placement contract.
    let maximized = if cfg!(target_os = "windows") && restoring.is_some() && native {
        Some(workspaces[0]["window_group"]["maximized"].as_bool().unwrap_or(false))
    } else { None };
    let resolved = if restoring.is_some() {
        reserve_child_window_label(&app, label)?
    } else {
        resolve_child_window_label(&app, label)?
    };
    let mut reservation = match resolved {
        // An existing window still adopts: the queue is drained by the
        // `window-adopt` listener that every window registers.
        ResolvedChildWindow::Existing(label) => {
            if deferred {
                return Err("A deferred workspace move requires a new window".into());
            }
            if restoring.is_some() {
                restore_child_window_frame(&app, &label, x, y, width, height, restoring, maximized);
            }
            if !deferred {
                state.window_registry.queue_adoption(&label, workspaces);
                emit_adopt(
                    &app,
                    WindowAdoptPayload {
                        from_label,
                        to_label: label.clone(),
                        workspace_ids,
                    },
                );
            }
            emit_registry_changed(&app, state.window_registry.revision());
            return Ok(label);
        }
        ResolvedChildWindow::New(reservation) => reservation,
    };
    let label = reservation.label().to_string();
    let active = creation_id.as_ref().filter(|_| deferred).map(|id| {
        let active = state.window_registry.track_workspace_window(&label, id.clone(), from_label.clone());
        reservation.track_workspace_creation(id.clone(), active.clone());
        active
    });
    crate::perf_timeline::mark("detach.rust.queued", Some(&label));

    // Queue *before* the window exists: the child asks for its adoption during
    // boot, so anything queued later would arrive after it decided it is empty.
    if !deferred { state.window_registry.queue_adoption(&label, workspaces); }
    let pending_app = app.clone();
    let failed_label = label.clone();
    reservation.on_creation_failed(move || {
        let Some(state) = pending_app.try_state::<AppState>() else { return; };
        let mut moved_count = 0;
        if !deferred {
            let rescued = state.window_registry.release_all(&failed_label, &from_label);
            moved_count = rescued.len();
            if moved_count > 0 {
                emit_adopt(&pending_app, WindowAdoptPayload {
                    workspace_ids: workspace_config_ids(&rescued),
                    from_label: failed_label.clone(),
                    to_label: from_label.clone(),
                });
            }
        }
        state.window_registry.forget_window(&failed_label);
        emit_registry_changed(&pending_app, state.window_registry.revision());
        if active.is_none_or(|flag| flag.load(std::sync::atomic::Ordering::Acquire)) {
            let _ = pending_app.emit_to(from_label.as_str(), "mycmux://window-open-failed", serde_json::json!({
                "label": failed_label,
                "creation_id": creation_id,
                "kind": if deferred { "move" } else { "restore" },
                "moved_count": moved_count,
            }));
        }
    });
    let spawned = if restoring.is_some() {
        spawn_child_window_with_restore(&app, reservation, x, y, width, height, restoring,
            Some(native), maximized)
    } else {
        spawn_child_window(&app, reservation, x, y, width, height)
    };
    spawned?;
    emit_registry_changed(&app, state.window_registry.revision());
    Ok(label)
}

/// Every window publishes its workspace list here on a debounced store
/// subscription. An AppShell publishes listener readiness separately so it
/// can receive management requests independently of layout publication.
#[tauri::command(async)]
pub async fn publish_window_fragment(
    window: tauri::Window,
    state: State<'_, AppState>,
    fragment: Option<WindowFragment>,
    require_published: Option<bool>,
    publication_id: Option<String>,
    account_management_ready: Option<bool>,
    account_management_document: Option<u64>,
    account_management_sequence: Option<u64>,
    account_management_subscription_id: Option<String>,
    read_account_management_document: Option<bool>,
) -> Result<Option<u64>, String> {
    if read_account_management_document == Some(true) {
        return state.window_registry.account_management_document(window.label(), publication_id.as_deref())
            .map(Some)
            .ok_or_else(|| "window publisher has been replaced or destroyed".into());
    }
    if let Some(ready) = account_management_ready {
        if fragment.is_some() {
            return Err("publish readiness separately from the window fragment".into());
        }
        let document = account_management_document.ok_or("window readiness document is missing")?;
        let sequence = account_management_sequence.ok_or("window readiness sequence is missing")?;
        let subscription = if ready {
            Some(account_management_subscription_id.filter(|id| !id.is_empty())
                .ok_or("window readiness subscription is missing")?)
        } else {
            None
        };
        return state.window_registry
            .set_account_management_ready(window.label(), publication_id.as_deref(), document, sequence, subscription)
            .then_some(None)
            .ok_or_else(|| "window publisher has been replaced or destroyed".into());
    }
    let fragment = fragment.ok_or("window fragment is missing")?;
    if fragment.window_label != window.label() {
        return Err("window fragment does not match its caller".into());
    }
    if !state.window_registry.publish_live_fragment(fragment, publication_id.as_deref())
        && require_published == Some(true)
    {
        return Err("window is closing or has been replaced before its fragment could be published".into());
    }
    // Deliberately no `window-registry-changed` emit: fragments are republished
    // on every debounce tick and nothing reacts to them synchronously (main
    // reads them at save time).
    Ok(None)
}

#[tauri::command(async)]
pub async fn take_pending_adoption(
    state: State<'_, AppState>,
    label: String,
) -> Result<Vec<Value>, String> {
    Ok(state.window_registry.take_pending_adoption(&label))
}

/// Hand workspaces from one window to another (merge-back on child close).
#[tauri::command(async)]
pub async fn release_workspaces(
    app: AppHandle,
    state: State<'_, AppState>,
    from_label: String,
    workspace_ids: Vec<String>,
    to_label: String,
) -> Result<usize, String> {
    if crate::commands::quit::is_quitting(&app) {
        return Err("Receiving window is preparing to quit".into());
    }
    // `get_webview_window` answers None for any window that also hosts a web
    // pane (a second webview under its own label), so the receiver must be
    // looked up as a plain window or a drop onto a window showing a web pane
    // is refused as "gone".
    if app.get_window(&to_label).is_none() {
        return Err("Receiving window no longer exists".to_string());
    }
    let moved = state
        .window_registry
        .release_to_open_window(&from_label, &workspace_ids, &to_label)?;
    if moved.is_empty() {
        return Ok(0);
    }
    // The receiver must own the sessions before it mounts them on `window-adopt`.
    let adopt_app = app.clone();
    let adopt_label = to_label.clone();
    let adopt_configs = moved.clone();
    if let Err(error) = crate::util::task::run_blocking("release_attachments", move || {
        crate::tearout::adopt_released_attachments(&adopt_app, &adopt_label, &adopt_configs)
    }).await {
        eprintln!("[window-registry] release attachment handoff failed to={to_label}: {error}");
    }
    emit_adopt(
        &app,
        WindowAdoptPayload {
            from_label,
            to_label,
            workspace_ids: workspace_config_ids(&moved),
        },
    );
    emit_registry_changed(&app, state.window_registry.revision());
    Ok(moved.len())
}

/// Read by main's `buildSnapshot` so `data.json` keeps every window's
/// workspaces (one missing there is gone on the next launch).
#[tauri::command(async)]
pub async fn get_window_fragments(state: State<'_, AppState>) -> Result<Vec<WindowFragment>, String> {
    Ok(state.window_registry.fragments())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct WindowTabIndexSnapshot {
    windows: Vec<crate::window_registry::WindowTabIndex>,
    #[serde(default)]
    quitting: bool,
}

#[derive(serde::Serialize)]
#[serde(untagged)]
pub enum WindowTabIndexResult {
    Rows(Vec<crate::window_registry::WindowTabIndex>),
    Snapshot(WindowTabIndexSnapshot),
}

pub(super) fn window_tab_index_result(
    mut windows: Vec<crate::window_registry::WindowTabIndex>,
    quitting: bool,
    include_quit_state: bool,
) -> WindowTabIndexResult {
    if quitting {
        for entry in &mut windows {
            entry.account_management_ready = false;
            entry.account_management_subscription = None;
        }
    }
    if quitting || include_quit_state {
        WindowTabIndexResult::Snapshot(WindowTabIndexSnapshot { windows, quitting })
    } else {
        WindowTabIndexResult::Rows(windows)
    }
}

#[tauri::command]
pub async fn get_window_tab_index(
    window: tauri::Window,
    state: State<'_, AppState>,
    include_quit_state: Option<bool>,
) -> Result<WindowTabIndexResult, String> {
    let mut index = state.window_registry.tab_index(window.label());
    // `tab_index` has released every registry entry guard before this PTY read.
    let processes = crate::commands::terminal::metadata_snapshot_for(
        &state.session_manager,
        &state.metadata_store,
    );
    for entry in &mut index {
        for workspace in &mut entry.workspaces {
            for pane in &mut workspace.panes {
                for tab in &mut pane.tabs {
                    if let Some(process) = processes.get(&tab.session_id) {
                        tab.pty_alive = true;
                        tab.live_agent_kind = process.live_agent_kind.clone();
                    }
                }
            }
        }
    }
    let quitting = crate::commands::quit::is_quitting(window.app_handle());
    Ok(window_tab_index_result(index, quitting, include_quit_state == Some(true)))
}

/// Settings-only hydration for windows that must not load workspaces. The
/// leader path reads the same file through `load_persistent_data`; this is the
/// same load with the workspace list left behind.
#[tauri::command(async)]
pub async fn get_app_settings(app_handle: AppHandle) -> Result<WindowSettings, String> {
    crate::util::task::run_blocking("get_app_settings", move || {
        let data = storage::load(&app_handle)?;
        Ok(WindowSettings { settings: data.settings, schema_version: data.schema_version })
    }).await
}

#[derive(serde::Serialize)]
pub struct WindowSettings {
    #[serde(flatten)]
    settings: AppSettings,
    schema_version: u32,
}

/// Explicit close is recorded before any PTY is killed. A later Destroyed
/// event therefore cannot mistake an intentional close for a crash.
///
/// Takes `tauri::Window`, not `tauri::WebviewWindow`: once a web pane has
/// attached its own webview, the window is no longer a `WebviewWindow` and
/// that argument fails with "current webview is not a WebviewWindow" — which
/// left a detached web pane window impossible to close or dock.
#[tauri::command(async)]
pub async fn set_window_close_intent(
    window: tauri::Window,
    state: State<'_, AppState>,
    closing: bool,
    publication_id: Option<String>,
) -> Result<(), String> {
    state.window_registry.set_publisher_close_intent(window.label(), publication_id.as_deref(), closing)
        .then_some(())
        .ok_or_else(|| "window publisher has been replaced or destroyed".into())
}

pub fn handle_window_destroyed(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<AppState>() else { return; };
    state.window_registry.unregister_fragment_publisher(label);
    crate::commands::window::release_window_role(app, label);
    if state.window_registry.take_close_intent(label) {
        state.window_registry.forget_closed_window(label);
        emit_registry_changed(app, state.window_registry.revision());
    } else {
        reclaim_destroyed_window(app, label);
    }
}

/// Crash-only rescue: no close request completed, so preserve live sessions.
pub fn reclaim_destroyed_window(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<AppState>() else { return; };
    let live = all_window_labels(app);
    let target = state.window_registry.rescue_target(label, &live);
    if let Some(target) = target {
        let moved = state.window_registry.release_all(label, &target);
        if !moved.is_empty() {
            // Off the event-loop thread: a session's lifecycle gate may be held by a spawn.
            let app = app.clone();
            let from_label = label.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = crate::tearout::adopt_released_attachments(&app, &target, &moved) {
                    eprintln!("[window-registry] rescue attachment handoff failed to={target}: {error}");
                }
                emit_adopt(&app, WindowAdoptPayload {
                    from_label,
                    to_label: target,
                    workspace_ids: workspace_config_ids(&moved),
                });
            });
        }
    }
    state.window_registry.forget_window(label);
    emit_registry_changed(app, state.window_registry.revision());
}

#[cfg(test)]
mod saved_window_tests {
    use super::{saved_window_decoration, workspaces_native_kind};
    use serde_json::json;

    #[test]
    fn undecorated_native_and_ordinary_windows_keep_distinct_saved_kinds() {
        let ordinary = json!({"window_group":{"label":"mycmux-w1","decorated":false,"native_tearout":false}});
        let native = json!({"window_group":{"label":"mycmux-w1","decorated":false,"native_tearout":true}});
        assert!(!workspaces_native_kind(&[ordinary], Some(false)));
        assert!(workspaces_native_kind(&[native], Some(false)));
        assert!(!workspaces_native_kind(&[], Some(true)));
    }

    #[test]
    fn restore_style_requires_a_complete_group_and_keeps_native_chrome() {
        let native = json!({"id":"a", "window_group":{"label":"mycmux-w2","decorated":false}});
        let normal = json!({"id":"b", "window_group":{"label":"mycmux-w2","decorated":true}});
        assert_eq!(saved_window_decoration(Some("mycmux-w2"), &[native.clone(), native.clone()]), Some(false));
        assert_eq!(saved_window_decoration(Some("mycmux-w2"), &[normal]), Some(true));
        assert_eq!(saved_window_decoration(Some("mycmux-w1"), &[native.clone()]), None);
        assert_eq!(saved_window_decoration(None, &[native]), None);
        assert_eq!(saved_window_decoration(Some("mycmux-w2"), &[json!({"id":"legacy"})]), None);
        assert_eq!(saved_window_decoration(Some("mycmux-w2"), &[]), None);
    }
}
