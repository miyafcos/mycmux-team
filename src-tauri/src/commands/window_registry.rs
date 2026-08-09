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

use crate::commands::window::{resolve_child_window_label, spawn_child_window, ResolvedChildWindow};
use crate::db::storage::{self, AppSettings};
use crate::window_registry::{
    workspace_config_ids, WindowAdoptPayload, WindowFragment, MAIN_WINDOW_LABEL,
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
    app: AppHandle,
    state: State<'_, AppState>,
    from_label: String,
    workspaces: Vec<Value>,
    label: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    if workspaces.is_empty() {
        return Err("open_workspace_window requires at least one workspace".to_string());
    }
    let workspace_ids = workspace_config_ids(&workspaces);
    if workspace_ids.len() != workspaces.len() {
        return Err("every workspace handed to open_workspace_window needs an id".to_string());
    }

    let label = match resolve_child_window_label(&app, label)? {
        // An existing window still adopts: the queue is drained by the
        // `window-adopt` listener that every window registers.
        ResolvedChildWindow::Existing(label) => {
            state.window_registry.queue_adoption(&label, workspaces);
            emit_adopt(
                &app,
                WindowAdoptPayload {
                    from_label,
                    to_label: label.clone(),
                    workspace_ids,
                },
            );
            emit_registry_changed(&app, state.window_registry.revision());
            return Ok(label);
        }
        ResolvedChildWindow::New(label) => label,
    };

    // Queue *before* the window exists: the child asks for its adoption during
    // boot, so anything queued later would arrive after it decided it is empty.
    state.window_registry.queue_adoption(&label, workspaces);
    if let Err(err) = spawn_child_window(&app, label.clone(), x, y, width, height) {
        // Never strand the workspaces (and their live sessions) in a queue no
        // window will ever drain.
        let orphaned = state.window_registry.take_pending_adoption(&label);
        state.window_registry.queue_adoption(MAIN_WINDOW_LABEL, orphaned);
        emit_registry_changed(&app, state.window_registry.revision());
        return Err(err);
    }
    emit_registry_changed(&app, state.window_registry.revision());
    Ok(label)
}

/// Every window publishes its own workspace list here on a debounced store
/// subscription. Main merges the non-main fragments into its `data.json`
/// snapshot — children never call `save_persistent_data`.
#[tauri::command(async)]
pub fn publish_window_fragment(
    state: State<'_, AppState>,
    fragment: WindowFragment,
) -> Result<(), String> {
    if fragment.window_label.is_empty() {
        return Err("publish_window_fragment requires a window label".to_string());
    }
    state.window_registry.publish_fragment(fragment);
    // Deliberately no `window-registry-changed` emit: fragments are republished
    // on every debounce tick and nothing reacts to them synchronously (main
    // reads them at save time).
    Ok(())
}

#[tauri::command(async)]
pub fn take_pending_adoption(
    state: State<'_, AppState>,
    label: String,
) -> Result<Vec<Value>, String> {
    Ok(state.window_registry.take_pending_adoption(&label))
}

/// Hand workspaces from one window to another (merge-back on child close).
#[tauri::command(async)]
pub fn release_workspaces(
    app: AppHandle,
    state: State<'_, AppState>,
    from_label: String,
    workspace_ids: Vec<String>,
    to_label: String,
) -> Result<usize, String> {
    let moved = state
        .window_registry
        .release_workspaces(&from_label, &workspace_ids, &to_label);
    if moved.is_empty() {
        return Ok(0);
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
/// workspaces (the phone remote reads that file for workspace names).
#[tauri::command(async)]
pub fn get_window_fragments(state: State<'_, AppState>) -> Result<Vec<WindowFragment>, String> {
    Ok(state.window_registry.fragments())
}

/// Settings-only hydration for windows that must not load workspaces. The
/// leader path reads the same file through `load_persistent_data`; this is the
/// same load with the workspace list left behind.
#[tauri::command(async)]
pub fn get_app_settings(app_handle: AppHandle) -> Result<AppSettings, String> {
    Ok(storage::load(&app_handle)?.settings)
}

/// `WindowEvent::Destroyed` hook installed on every child window. Anything the
/// window still owns goes back to main so its PTY sessions stay reachable —
/// the clean close path has already released, so this is normally a no-op.
pub fn reclaim_destroyed_window(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let moved = state.window_registry.release_all(label, MAIN_WINDOW_LABEL);
    state.window_registry.forget_window(label);
    if moved.is_empty() {
        emit_registry_changed(app, state.window_registry.revision());
        return;
    }
    crate::diag_warn!(
        "window-registry",
        "window {label} was destroyed holding {} workspace(s) — returning them to main",
        moved.len()
    );
    emit_adopt(
        app,
        WindowAdoptPayload {
            from_label: label.to_string(),
            to_label: MAIN_WINDOW_LABEL.to_string(),
            workspace_ids: workspace_config_ids(&moved),
        },
    );
    emit_registry_changed(app, state.window_registry.revision());
}
