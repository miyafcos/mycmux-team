//! Opt-in pane tear-out. Every UI mutation is posted from an async command.
mod geometry;
pub mod log;
#[cfg(target_os = "windows")]
mod native;
#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod native;
mod performance;
mod release;
mod release_latch;
use release::{ReleaseEscrow, ReleaseFrame, ReleasePoint};
use release_latch::ReleaseLatch;
mod transfer;

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct TearoutState {
    spare: Mutex<Option<(String, bool)>>,
    warming: AtomicBool,
    spare_generation: AtomicU64,
    moves: Mutex<HashMap<String, Arc<MoveState>>>,
    transfers: Mutex<HashMap<String, transfer::Transfer>>,
    releases: Mutex<HashMap<String, Arc<ReleaseEscrow>>>,
    #[cfg(target_os = "windows")]
    restored_windows: Mutex<HashMap<String, bool>>,
}

/// An idle spare must not keep the app alive or receive crash-rescued work.
pub fn release_idle_after_destroy(app: &AppHandle, dying: &str) {
    expire_releases_for_window(app, dying);
    let state = app.state::<TearoutState>();
    #[cfg(target_os = "windows")]
    if let Ok(mut restored) = state.restored_windows.lock() { restored.remove(dying); }
    let label = state
        .spare
        .lock()
        .ok()
        .and_then(|spare| spare.as_ref().map(|(label, _)| label.clone()));
    let Some(label) = label else {
        return;
    };
    if label == dying {
        state.spare_generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut spare) = state.spare.lock() {
            *spare = None;
        }
        return;
    }
    if app
        .windows()
        .keys()
        .any(|candidate| candidate != dying && candidate != &label)
    {
        return;
    }
    state.spare_generation.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut spare) = state.spare.lock() {
        *spare = None;
    }
    if let Some(window) = app.get_window(&label) {
        let _ = window.destroy();
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Approval {
    pub receiver: String,
    pub token: String,
    pub target: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_revision: Option<String>,
}

/// The intent belongs to the drag ID; source labels never determine it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveMode { #[default] Detach, Dock }
impl MoveMode { fn allows_dock(self) -> bool { self == Self::Dock } }

#[derive(Default)]
pub struct MoveState {
    mode: MoveMode,
    grab_offset: Option<geometry::GrabOffset>,
    start_alignment: Mutex<Option<geometry::StartAlignment>>,
    closed: AtomicBool,
    receiver: Mutex<Option<String>>,
    receiver_since: AtomicU64,
    approval: Mutex<Option<Approval>>,
    alpha: AtomicU8,
    entered: AtomicBool,
    exited: AtomicBool,
    escaped: AtomicBool,
    escaped_at: AtomicU64,
    cancelled: AtomicBool,
    failed: AtomicBool,
    observer_removed: AtomicBool,
    started_at: AtomicU64,
    synthetic: AtomicBool,
    moved: AtomicBool,
    dragged: AtomicBool,
    synthetic_origin: Mutex<Option<(f64, f64)>>,
    original: Mutex<Option<WindowGeometry>>,
    applied_alpha: AtomicU8,
    alpha_calls: AtomicU64,
    sample_count: AtomicU64,
    receiver_epoch: AtomicU64,
    preview_revision: AtomicU64,
    region_count: AtomicU64,
    pacing: Mutex<performance::SamplePacer>,
    metrics: performance::NativeMetrics,
    release: ReleaseLatch<ReleasePoint>,
    moving_label: Mutex<Option<String>>,
    source_label: Mutex<Option<String>>,
}

impl MoveState {
    fn require_mode(&self, mode: MoveMode) -> Result<(), String> {
        if self.mode == mode { Ok(()) } else { Err("tearout_move_mode_changed".into()) }
    }
}

/// Exercise the real receiver and opacity path without moving the user's pointer.
#[tauri::command]
pub async fn tearout_synthetic_sample(
    window: tauri::Window,
    app: AppHandle,
    id: String,
    label: String,
    receiver: Option<String>,
    client_x: f64,
    client_y: f64,
    phase: String,
    mode: Option<MoveMode>,
    escaped: bool,
    source_label: Option<String>,
    region_count: Option<usize>,
    diagnostics: Option<bool>,
    legacy_samples: Option<bool>,
    recorder: Option<bool>,
) -> Result<serde_json::Value, String> {
    if !crate::test_profile::is_active() {
        return Err("tearout_synthetic_requires_test_profile".into());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (
            app,
            window,
            id,
            label,
            receiver,
            client_x,
            client_y,
            phase,
            mode,
            escaped,
            source_label,
            region_count,
            diagnostics,
            legacy_samples,
            recorder,
        );
        Err("Native pane tear-out is Windows-only".into())
    }
    #[cfg(target_os = "windows")]
    {
        if !matches!(phase.as_str(), "move" | "end") || !label.starts_with("mycmux-w") {
            return Err("tearout_synthetic_sample_invalid".into());
        }
        let mode = mode.ok_or("tearout_move_mode_required")?;
        let source = source_label.unwrap_or_else(|| window.label().to_owned());
        on_ui(&app, move |app| {
            native::synthetic_sample(
                &app,
                id,
                label,
                source,
                mode,
                region_count.unwrap_or(1),
                receiver,
                client_x,
                client_y,
                &phase,
                escaped,
                diagnostics.unwrap_or(false),
                legacy_samples.unwrap_or(false),
                recorder.unwrap_or(true),
            )
        })
        .await
    }
    #[cfg(target_os = "macos")]
    {
        if phase == "identity" && label.starts_with("mycmux-w") {
            return on_ui(&app, move |app| native::window_identity(&app, &label)).await;
        }
        if !matches!(phase.as_str(), "move" | "end") || !label.starts_with("mycmux-w") {
            return Err("tearout_synthetic_sample_invalid".into());
        }
        let mode = mode.ok_or("tearout_move_mode_required")?;
        let source = source_label.unwrap_or_else(|| window.label().to_owned());
        on_ui(&app, move |app| {
            native::synthetic_sample(
                &app,
                id,
                label,
                source,
                mode,
                region_count.unwrap_or(1),
                receiver,
                client_x,
                client_y,
                &phase,
                escaped,
                diagnostics.unwrap_or(false),
                legacy_samples.unwrap_or(false),
                recorder.unwrap_or(true),
            )
        })
        .await
    }
}

#[tauri::command]
pub async fn tearout_attach(
    window: tauri::Window,
    state: State<'_, crate::AppState>,
    session_id: String,
    on_data: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<(), String> {
    // The DashMap reference prevents removal while the existing channel swaps.
    // This path has no spawn branch, even if the process disappears mid-drag.
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let _ = state;
    crate::util::task::run_blocking("tearout_attach", move || {
        // Gate before DashMap reference, matching create/kill; never wait on
        // this mutex in the async runtime or while retaining a session.
        let gate = crate::commands::terminal::codex_restore_lifecycle_gate(&session_id);
        let _guard = gate.lock().unwrap_or_else(|e| e.into_inner());
        let state = app.state::<crate::AppState>();
        if state.window_registry.is_closing(&label) || app.get_window(&label).is_none() {
            return Err("tearout_attachment_window_closed".into());
        }
        let session = state.session_manager.get(&session_id).ok_or("tearout_session_not_alive")?;
        crate::commands::terminal::invalidate_codex_restore_notice(&app, &session_id);
        let result = session.replace_data_channel(on_data).map(|_| ());
        crate::commands::terminal::publish_codex_restore_epoch(&app, &session_id, Some(session.session_epoch()));
        result
    }).await
}

#[tauri::command]
pub async fn tearout_prepare(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, TearoutState>,
    id: String,
    receiver: String,
    configs: Vec<serde_json::Value>,
    delivery_token: String,
    finalizer: Option<String>,
) -> Result<Option<NativeStartRefusal>, String> {
    if app.get_window(&receiver).is_none()
        || app
            .state::<crate::AppState>()
            .window_registry
            .is_closing(&receiver)
    {
        return Err("tearout_receiver_unavailable".into());
    }
    if delivery_token.is_empty() || configs.is_empty()
        || configs
            .iter()
            .any(|config| crate::window_registry::workspace_config_id(config).is_none())
    {
        return Err("tearout_transfer_config_invalid".into());
    }
    let mut transfers = state.transfers.lock().map_err(|e| e.to_string())?;
    if transfers.contains_key(&id) {
        return Err("tearout_transfer_duplicate".into());
    }
    if let Some(refusal) = transfer_refusal(&transfers, window.label(), &id, Some(&configs)) {
        return Ok(Some(refusal));
    }
    transfers.insert(id, transfer::Transfer::new(window.label().into(), receiver, configs, delivery_token, finalizer));
    Ok(None)
}

#[tauri::command]
pub async fn tearout_phase(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, TearoutState>,
    id: String,
    phase: transfer::Phase,
) -> Result<bool, String> {
    let mut transfers = state.transfers.lock().map_err(|e| e.to_string())?;
    let transfer = transfers.get_mut(&id).ok_or("tearout_transfer_missing")?;
    transfer.authorize(window.label())?;
    if !transfer.advance(phase)? {
        return Ok(false);
    }
    let app_state = app.state::<crate::AppState>();
    if phase == transfer::Phase::Committed {
        app_state
            .window_registry
            .queue_adoption(&transfer.receiver, transfer.configs.clone());
    } else if matches!(
        phase,
        transfer::Phase::Received | transfer::Phase::RolledBack
    ) {
        let ids = crate::window_registry::workspace_config_ids(&transfer.configs);
        app_state
            .window_registry
            .remove_pending_adoption(&transfer.receiver, &ids);
    }
    Ok(true)
}

// The source commits only after real receipt and publication. Keep the
// reservation through Cleaned; emit failure leaves it locked for recovery.
fn finalize_transfer(app: &AppHandle, caller: &str, id: &str, token: &str) -> Result<(), String> {
    let state = app.state::<TearoutState>();
    let mut transfers = state.transfers.lock().map_err(|e| e.to_string())?;
    let transfer = transfers.get_mut(id).ok_or("tearout_transfer_missing")?;
    transfer.check_finalize(caller, token)?;
    finalize_transfer_entry(app, caller, transfer, token)
}

fn finalize_transfer_entry(app: &AppHandle, caller: &str, transfer: &mut transfer::Transfer, token: &str) -> Result<(), String> {
    transfer.check_finalize(caller, token)?;
    app.emit_to(&transfer.receiver, "mycmux://tearout-finalize",
        serde_json::json!({ "token": token, "source": transfer.source })).map_err(|e| e.to_string())?;
    transfer.finalized = true;
    Ok(())
}

#[tauri::command]
pub async fn tearout_finalize(window: tauri::Window, app: AppHandle, id: String, token: String) -> Result<(), String> {
    finalize_transfer(&app, window.label(), &id, &token)
}

#[tauri::command]
pub async fn tearout_forget(window: tauri::Window, state: State<'_, TearoutState>, id: String) -> Result<bool, String> {
    let mut transfers = state.transfers.lock().map_err(|e| e.to_string())?;
    if let Some(transfer) = transfers.get(&id) {
        transfer.authorize(window.label())?;
        if !transfer.can_forget() { return Ok(false); }
    }
    Ok(transfers.remove(&id).is_some())
}

#[tauri::command]
pub async fn tearout_cancel_move(
    app: AppHandle,
    state: State<'_, TearoutState>,
    id: String,
    label: String,
) -> Result<(), String> {
    if let Some(shared) = state
        .moves
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
    {
        shared.cancelled.store(true, Ordering::Release);
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            native::cancel(&app, &label)?;
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, label);
    }
    Ok(())
}

// An async caller is off the WebView IPC callback. Never hold a state lock
// while posting UI work or entering the native move loop.
pub async fn on_ui<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        native::defer(move || { let _ = send.send(action(handle)); });
        #[cfg(not(target_os = "macos"))]
        { let _ = send.send(action(handle)); }
    })
    .map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tearout_warm(
    app: AppHandle,
    state: State<'_, TearoutState>,
) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, state);
        return Ok(None);
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        if let Some((label, _)) = state.spare.lock().map_err(|e| e.to_string())?.as_ref() {
            return Ok(Some(label.clone()));
        }
        if state.warming.swap(true, Ordering::AcqRel) {
            return Ok(None);
        }
        let reservation = match crate::commands::window::resolve_child_window_label(&app, None) {
            Ok(crate::commands::window::ResolvedChildWindow::New(r)) => r,
            other => {
                state.warming.store(false, Ordering::Release);
                return Err(format!("Fresh tear-out reservation failed: {other:?}"));
            }
        };
        let label = reservation.label().to_string();
        let generation = state.spare_generation.load(Ordering::Acquire);
        *state.spare.lock().map_err(|e| e.to_string())? = Some((label.clone(), false));
        let result = on_ui(&app, move |app| {
            if app
                .state::<TearoutState>()
                .spare_generation
                .load(Ordering::Acquire)
                != generation
            {
                return Ok(());
            }
            #[cfg(target_os = "macos")]
            native::capture_mouse_down(true);
            app.state::<crate::AppState>()
                .window_registry
                .set_close_intent(reservation.label(), true);
            let builder = tauri::WebviewWindowBuilder::new(
                &app,
                reservation.label(),
                tauri::WebviewUrl::default(),
            )
            .title("mycmux")
            .decorations(false)
            .resizable(true)
            .visible(false)
            .inner_size(720.0, 520.0)
            .min_inner_size(240.0, 160.0)
            .initialization_script("window.__MYCMUX_TEAROUT_WINDOW__ = true;");
            // Windows must not retain tao's MARKER_DONT_FOCUS after first reveal.
            // Quiet first show is handled natively while the window is hidden.
            #[cfg(target_os = "windows")]
            let builder = builder.focused(true);
            #[cfg(target_os = "macos")]
            let builder = builder.focused(false);
            let window = builder.build()
            .map_err(|e| {
                app.state::<crate::AppState>()
                    .window_registry
                    .set_close_intent(reservation.label(), false);
                e.to_string()
            })?;
            crate::watchdog::register_process_failed(window.as_ref());
            window
                .set_size(tauri::LogicalSize::new(720.0, 520.0))
                .map_err(|e| e.to_string())?;
            #[cfg(target_os = "windows")]
            native::watch_normal_insets(&window.as_ref().window())?;
            if let Some(icon) = app.default_window_icon().cloned() {
                let _ = window.set_icon(icon);
            }
            if app
                .state::<TearoutState>()
                .spare_generation
                .load(Ordering::Acquire)
                != generation
            {
                window.destroy().map_err(|e| e.to_string())?;
            }
            drop(reservation);
            Ok(())
        })
        .await;
        if let Err(error) = result {
            let owns_failed_spare = {
                let mut spare = state.spare.lock().map_err(|e| e.to_string())?;
                match spare.as_mut() {
                    Some((failed_label, ready)) if failed_label == &label => {
                        *ready = false;
                        true
                    }
                    _ => false,
                }
            };
            if owns_failed_spare {
                let failed_label = label.clone();
                let cleanup = on_ui(&app, move |app| {
                    if let Some(window) = app.get_window(&failed_label) {
                        window.destroy().map_err(|e| e.to_string())?;
                    }
                    Ok(())
                })
                .await;
                if let Err(cleanup_error) = cleanup {
                    // Keep the failed spare tracked so OFF/last-window cleanup can retry.
                    state.warming.store(false, Ordering::Release);
                    return Err(format!(
                        "{error}; tearout_spare_cleanup_failed: {cleanup_error}"
                    ));
                }
                let mut spare = state.spare.lock().map_err(|e| e.to_string())?;
                if spare
                    .as_ref()
                    .is_some_and(|(failed_label, _)| failed_label == &label)
                {
                    *spare = None;
                }
            }
            state.warming.store(false, Ordering::Release);
            return Err(error);
        }
        state.warming.store(false, Ordering::Release);
        Ok(Some(label))
    }
}

#[tauri::command]
pub async fn tearout_child_ready(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, TearoutState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let maximized = state.restored_windows.lock().map_err(|e| e.to_string())?.remove(window.label());
        if let Some(maximized) = maximized {
            let label = window.label().to_owned();
            on_ui(&app, move |app| {
                let window = app.get_window(&label).ok_or("Restored window disappeared")?;
                native::quiet_show(&window, maximized)
            }).await?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
    if let Some((label, ready)) = state.spare.lock().map_err(|e| e.to_string())?.as_mut() {
        if label == window.label() {
            *ready = true;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn tearout_take_spare(
    app: AppHandle,
    state: State<'_, TearoutState>,
) -> Result<Option<String>, String> {
    let mut spare = state.spare.lock().map_err(|e| e.to_string())?;
    if spare.as_ref().is_some_and(|(_, ready)| *ready) {
        let label = spare.take().map(|(label, _)| label);
        if let Some(label) = &label {
            app.state::<crate::AppState>()
                .window_registry
                .set_close_intent(label, false);
        }
        Ok(label)
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn tearout_release_spare(
    app: AppHandle,
    state: State<'_, TearoutState>,
) -> Result<(), String> {
    state.spare_generation.fetch_add(1, Ordering::AcqRel);
    #[cfg(target_os = "macos")]
    let _ = on_ui(&app, |_| {
        native::capture_mouse_down(false);
        Ok(())
    })
    .await;
    let label = state
        .spare
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .map(|(label, _)| label);
    if let Some(label) = label {
        on_ui(&app, move |app| {
            app.state::<crate::AppState>()
                .window_registry
                .set_close_intent(&label, true);
            if let Some(window) = app.get_window(&label) {
                window.destroy().map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct Reveal {
    shown_at: u64,
    visible_at: u64,
    scale: f64,
    monitor: Option<String>,
    focus_stolen: bool,
}

pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tauri::command]
pub async fn tearout_show(
    app: AppHandle,
    label: String,
    offset_x: f64,
    offset_y: f64,
    logical_width: Option<f64>,
    logical_height: Option<f64>,
) -> Result<Reveal, String> {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, label, offset_x, offset_y, logical_width, logical_height);
        Err("Native pane tear-out is Windows-only".into())
    }
    #[cfg(target_os = "windows")]
    {
        on_ui(&app, move |app| {
            native::reveal(&app, &label, offset_x, offset_y,
                logical_width.unwrap_or(720.0), logical_height.unwrap_or(520.0))
        }).await
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (logical_width, logical_height);
        on_ui(&app, move |app| {
            native::reveal(&app, &label, offset_x, offset_y)
        }).await
    }
}

/// Proof that a complete-window regrab was refused before reserving a move.
/// Fresh transfers never receive this result after provisional ownership changes.
#[derive(serde::Serialize)]
pub struct NativeStartRefusal {
    kind: &'static str,
    pre_ownership: bool,
    phase: &'static str,
    owner_id: String,
    source: String,
    label: String,
}
impl NativeStartRefusal {
    fn moving(owner_id: &str, source: &str, label: &str) -> Self {
        Self { kind: "rejected_busy", pre_ownership: true, phase: "moving",
            owner_id: owner_id.into(), source: source.into(), label: label.into() }
    }
}

fn transfer_refusal(transfers: &HashMap<String, transfer::Transfer>, requester: &str, id: &str,
    configs: Option<&[serde_json::Value]>) -> Option<NativeStartRefusal> {
    transfers.iter().find(|(owner_id, transfer)| owner_id.as_str() != id &&
        (transfer.reserves_window(requester) || configs.is_some_and(|configs| transfer.reserves_sessions(configs))))
        .map(|(owner_id, transfer)| NativeStartRefusal::moving(owner_id, &transfer.source, requester))
}

#[tauri::command]
pub async fn tearout_transfer_refusal(window: tauri::Window, state: State<'_, TearoutState>, id: String)
    -> Result<Option<NativeStartRefusal>, String> {
    let _ = id;
    let transfers = state.transfers.lock().map_err(|e| e.to_string())?;
    // An incoming reservation never becomes the child's own operation, even
    // when a caller reuses the source's drag ID.
    Ok(transfers.iter().find(|(_, transfer)| transfer.reserves_window(window.label()))
        .map(|(owner_id, transfer)| NativeStartRefusal::moving(owner_id, &transfer.source, window.label())))
}

fn provisional_move_refusal(transfers: &HashMap<String, transfer::Transfer>, requester: &str,
    label: &str, id: &str) -> Option<NativeStartRefusal> {
    transfers.iter().find(|(owner_id, transfer)| transfer.reserves_window(requester)
        || (transfer.reserves_window(label) && !(owner_id.as_str() == id && transfer.source == requester)))
        .map(|(owner_id, transfer)| NativeStartRefusal::moving(owner_id, &transfer.source, label))
}

fn pre_ownership_regrab_refusal(
    moves: &HashMap<String, Arc<MoveState>>, requester: &str, label: &str, id: &str, regrab: bool,
) -> Result<Option<NativeStartRefusal>, String> {
    if !regrab || requester != label { return Ok(None); }
    for (owner_id, owner) in moves {
        if owner_id != id && !owner.closed.load(Ordering::Acquire)
            && owner.moving_label.lock().map_err(|e| e.to_string())?.as_deref() == Some(label)
        {
            let owner_source = owner.source_label.lock().map_err(|e| e.to_string())?;
            if let Some(source) = owner_source.as_deref() {
                return Ok(Some(NativeStartRefusal::moving(owner_id, source, label)));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn tearout_start_move(
    window: tauri::Window,
    app: AppHandle,
    label: String,
    id: String,
    mode: MoveMode,
    region_count: Option<usize>,
    regrab: Option<bool>,
    offset_x: Option<f64>,
    offset_y: Option<f64>,
) -> Result<Option<NativeStartRefusal>, String> {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, window, label, id, mode, region_count, regrab, offset_x, offset_y);
        Err("Native pane tear-out is Windows-only".into())
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let source = window.label().to_owned();
        if mode.allows_dock() && source != label { return Err("tearout_dock_source_invalid".into()); }
        let before_ownership = mode.allows_dock() && regrab == Some(true) && source == label;
        let state = app.state::<TearoutState>();
        {
            let releases = state.releases.lock().map_err(|e| e.to_string())?;
            if let Some(release) = releases.values().find(|release| release.pending_for(&label)) {
                if before_ownership && release.frame.id != id {
                    return Ok(Some(NativeStartRefusal::moving(&release.frame.id, &release.frame.source, &label)));
                }
                return Err("tearout_release_pending".into());
            }
        }
        let grab_offset = if mode == MoveMode::Detach && regrab != Some(true) && source != label {
            offset_x.zip(offset_y).map(|(x, y)| geometry::GrabOffset { x, y })
        } else { None };
        let shared = Arc::new(MoveState { mode, grab_offset, ..MoveState::default() });
        *shared.moving_label.lock().map_err(|e| e.to_string())? = Some(label.clone());
        *shared.source_label.lock().map_err(|e| e.to_string())? = Some(source.clone());
        shared.region_count.store(region_count.unwrap_or(1).max(1) as u64, Ordering::Release);
        {
            // Checking and reserving under one lock also covers the interval
            // before the native loop sends its first lifecycle sample.
            let transfers = state.transfers.lock().map_err(|e| e.to_string())?;
            if let Some(refusal) = provisional_move_refusal(&transfers, &source, &label, &id) {
                if before_ownership { return Ok(Some(refusal)); }
                return Err("tearout_transfer_pending".into());
            }
            let mut moves = state.moves.lock().map_err(|e| e.to_string())?;
            if let Some(refusal) = pre_ownership_regrab_refusal(&moves, &source, &label, &id, before_ownership)? {
                return Ok(Some(refusal));
            }
            if moves.contains_key(&id) { return Err("tearout_move_id_reused".into()); }
            moves.insert(id.clone(), shared.clone());
        }
        let key = id.clone();
        let result = on_ui(&app, move |app| {
            native::start(&app, &label, source, id, shared)
        }).await;
        if result.is_err() {
            state.moves.lock().map_err(|e| e.to_string())?.remove(&key);
        }
        // A native-start failure after reservation retains its recovery path.
        result.map(|()| None)
    }
}

fn get_release(app: &AppHandle, id: &str) -> Result<Arc<ReleaseEscrow>, String> {
    app.state::<TearoutState>().releases.lock().map_err(|e| e.to_string())?
        .get(id).cloned().ok_or("tearout_release_missing".into())
}
async fn release_opacity(app: &AppHandle, release: Arc<ReleaseEscrow>, alpha: u8) -> Result<(), String> {
    on_ui(app, move |app| {
        if alpha == 128 && !release.painting() { return Err("tearout_release_expired".into()); }
        let superseded = app.state::<TearoutState>().moves.lock().map_err(|e| e.to_string())?.values()
            .any(|moving| !moving.closed.load(Ordering::Acquire) && moving.moving_label.lock().is_ok_and(|label| label.as_deref() == Some(release.frame.label.as_str())));
        if superseded { return if alpha == 128 { Err("tearout_release_superseded".into()) } else { Ok(()) }; }
        if let Some(window) = app.get_window(&release.frame.label) {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            native::set_alpha(&window, alpha)?;
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let _ = (window, alpha);
        } else if alpha == 128 { return Err("tearout_moving_window_missing".into()); }
        Ok(())
    }).await
}
async fn verify_release_geometry(app: &AppHandle, release: Arc<ReleaseEscrow>) -> Result<(), String> {
    on_ui(app, move |app| {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if !release.matches_geometry(&native::receiver_geometry(&app, &release.frame.receiver)?) { return Err("tearout_drop_target_changed".into()); }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let _ = (app, release);
        Ok(())
    }).await
}
fn finished_release(app: &AppHandle, release: &ReleaseEscrow) {
    for label in [&release.frame.source, &release.frame.label] {
        let _ = app.emit_to(label, "mycmux://tearout-release-finished", serde_json::json!({"id": release.frame.id}));
    }
}
fn discard_release(app: &AppHandle, release: &Arc<ReleaseEscrow>) {
    if let Ok(mut releases) = app.state::<TearoutState>().releases.lock() {
        if releases.get(&release.frame.id).is_some_and(|current| Arc::ptr_eq(current, release)) {
            releases.remove(&release.frame.id); release.cancel(); finished_release(app, release);
        }
    }
}
pub(super) fn arm_release(app: &AppHandle, mut frame: ReleaseFrame) -> Result<(), String> {
    if !frame.mode.allows_dock() { return Err("tearout_detach_has_no_drop".into()); }
    frame.token = uuid::Uuid::new_v4().to_string();
    let elapsed = std::time::Duration::from_millis(unix_ms().saturating_sub(frame.point.at));
    let release = ReleaseEscrow::with_elapsed(frame, elapsed);
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let release = { let geometry = native::receiver_geometry(app, &release.frame.receiver)?; release.with_geometry(geometry) };
    let release = Arc::new(release);
    {
        let state = app.state::<TearoutState>();
        let mut releases = state.releases.lock().map_err(|e| e.to_string())?;
        if releases.len() >= 64 || releases.contains_key(&release.frame.id) { return Err("tearout_release_capacity".into()); }
        releases.insert(release.frame.id.clone(), release.clone());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(release::ESCROW_LIMIT).await;
        let current = get_release(&handle, &release.frame.id).ok().is_some_and(|current| Arc::ptr_eq(&current, &release));
        if current {
            let _ = release_opacity(&handle, release.clone(), 255).await;
            discard_release(&handle, &release);
        }
    });
    Ok(())
}
fn expire_releases_for_window(app: &AppHandle, label: &str) {
    let releases: Vec<_> = app.state::<TearoutState>().releases.lock().map(|releases| releases.values()
        .filter(|release| release.frame.source == label || release.frame.label == label || release.frame.receiver == label)
        .cloned().collect()).unwrap_or_default();
    for release in releases {
        discard_release(app, &release);
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { let _ = release_opacity(&handle, release, 255).await; });
    }
}

#[tauri::command]
pub async fn tearout_resolve_release(window: tauri::Window, app: AppHandle, id: String) -> Result<Option<Approval>, String> {
    let release = get_release(&app, &id)?;
    let wait = match release.request(window.label()) {
        Ok(wait) => wait,
        Err(error) => {
            if window.label() == release.frame.source && release.remaining().is_zero() {
                discard_release(&app, &release);
                release_opacity(&app, release, 255).await?;
            }
            return Err(error);
        }
    };
    let result = async {
        app.emit_to(&release.frame.receiver, "mycmux://tearout-release",
            serde_json::json!({ "id": id, "epoch": release.frame.receiver_epoch })).map_err(|e| e.to_string())?;
        tokio::time::timeout(release.remaining(), wait).await.map_err(|_| "tearout_release_timeout".to_owned())?
            .map_err(|_| "tearout_release_cancelled".to_owned())?
    }.await;
    // Restoration also runs on lost renderer/transport replies. Keep a valid
    // token only until its receiver consumes it, independently of moves[].
    let restored = release_opacity(&app, release.clone(), 255).await;
    if !matches!(&result, Ok(Some(_))) || restored.is_err() { discard_release(&app, &release); }
    restored?;
    result
}

#[tauri::command]
pub async fn tearout_release_begin(window: tauri::Window, app: AppHandle, id: String, epoch: u64) -> Result<ReleaseFrame, String> {
    let release = get_release(&app, &id)?;
    let frame = release.begin(window.label(), epoch)?;
    let exposed = async {
        verify_release_geometry(&app, release.clone()).await?;
        release_opacity(&app, release.clone(), 128).await
    }.await;
    if let Err(error) = exposed {
        let _ = release.decide(window.label(), epoch, None, None, None, Some(error.clone()));
        return Err(error);
    }
    Ok(frame)
}
#[tauri::command]
pub async fn tearout_release_decision(window: tauri::Window, app: AppHandle, id: String, epoch: u64,
    token: Option<String>, target: Option<serde_json::Value>, layout_revision: Option<String>, error: Option<String>) -> Result<bool, String> {
    get_release(&app, &id)?.decide(window.label(), epoch, token, target, layout_revision, error)
}
#[tauri::command]
pub async fn tearout_release_cancel(window: tauri::Window, app: AppHandle, id: String) -> Result<(), String> {
    let Some(release) = app.state::<TearoutState>().releases.lock().map_err(|e| e.to_string())?.get(&id).cloned() else { return Ok(()); };
    if window.label() != release.frame.source && window.label() != release.frame.label && window.label() != release.frame.receiver {
        return Err("tearout_release_caller_invalid".into());
    }
    let restored = release_opacity(&app, release.clone(), 255).await;
    discard_release(&app, &release);
    restored
}
#[tauri::command]
pub async fn tearout_release_consume(window: tauri::Window, app: AppHandle, id: String, token: String,
    target: serde_json::Value, layout_revision: String) -> Result<bool, String> {
    let release = get_release(&app, &id)?;
    if window.label() != release.frame.receiver { return Ok(false); }
    if let Err(error) = verify_release_geometry(&app, release.clone()).await {
        discard_release(&app, &release); return Err(error);
    }
    let consumed = release.consume(window.label(), &token, &target, &layout_revision);
    if consumed { discard_release(&app, &release); }
    Ok(consumed)
}

#[tauri::command]
pub async fn tearout_preview(
    window: tauri::Window,
    state: State<'_, TearoutState>,
    id: String,
    token: Option<String>,
    target: Option<serde_json::Value>,
    revision: Option<u64>,
    epoch: Option<u64>,
) -> Result<bool, String> {
    let shared = state
        .moves
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned();
    let Some(shared) = shared else {
        return Ok(false);
    };
    if !shared.mode.allows_dock() || shared.closed.load(Ordering::Acquire) {
        return Ok(false);
    }
    if shared
        .receiver
        .lock()
        .map_err(|e| e.to_string())?
        .as_deref()
        != Some(window.label())
    {
        return Ok(false);
    }
    let mut approval = shared.approval.lock().map_err(|e| e.to_string())?;
    if shared.closed.load(Ordering::Acquire) {
        return Ok(false);
    }
    let current_revision = shared.preview_revision.load(Ordering::Acquire);
    let proposed = revision.unwrap_or(current_revision);
    if epoch.is_some_and(|epoch| epoch != shared.receiver_epoch.load(Ordering::Acquire))
        || !geometry::accepts_preview_revision(current_revision, proposed)
        || shared.region_count.load(Ordering::Acquire) > 1
            && target
                .as_ref()
                .is_some_and(|target| target["kind"] != "workspace")
    {
        return Ok(false);
    }
    if token.is_some()
        && !geometry::dwell_ready(
            Some(shared.receiver_since.load(Ordering::Acquire)),
            unix_ms(),
            true,
        )
    {
        return Ok(false);
    }
    *approval = token.zip(target).map(|(token, target)| Approval {
        receiver: window.label().into(),
        token,
        target,
        release_id: None, layout_revision: None,
    });
    shared.preview_revision.store(proposed, Ordering::Release);
    if approval.is_none() {
        shared.alpha.store(255, Ordering::Release);
    }
    Ok(true)
}

#[tauri::command]
pub async fn tearout_alpha(
    window: tauri::Window,
    app: AppHandle,
    label: String,
    id: String,
    alpha: u8,
    revision: Option<u64>,
    epoch: Option<u64>,
    token: Option<String>,
) -> Result<(), String> {
    if !matches!(alpha, 128 | 255) {
        return Err("Unsupported tear-out alpha".into());
    }
    let shared = app
        .state::<TearoutState>()
        .moves
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned();
    if let Some(shared) = shared {
        if !shared.mode.allows_dock() { return Ok(()); }
        if shared
            .receiver
            .lock()
            .map_err(|e| e.to_string())?
            .as_deref()
            != Some(window.label())
        {
            return Ok(());
        }
        let approval = shared.approval.lock().map_err(|e| e.to_string())?;
        let current = revision
            .is_none_or(|revision| revision == shared.preview_revision.load(Ordering::Acquire))
            && epoch.is_none_or(|epoch| epoch == shared.receiver_epoch.load(Ordering::Acquire));
        let matches_token = token.as_ref().is_none_or(|token| {
            approval
                .as_ref()
                .is_some_and(|approval| &approval.token == token)
        });
        if current
            && (alpha == 255
                || (!shared.closed.load(Ordering::Acquire) && approval.is_some() && matches_token))
        {
            shared.alpha.store(alpha, Ordering::Release);
        }
    }
    let _ = label;
    Ok(())
}

#[tauri::command]
pub async fn tearout_retire(
    window: tauri::Window,
    app: AppHandle,
    label: String,
    receipt_label: Option<String>,
    receipt_token: Option<String>,
    transfer_id: Option<String>,
    finalize_label: Option<String>,
    finalize_token: Option<String>,
    record: Option<log::DragRecord>,
) -> Result<(), String> {
    let caller = window.label().to_owned();
    if let Some(id) = transfer_id.as_deref() {
        let state = app.state::<TearoutState>();
        let transfers = state.transfers.lock().map_err(|e| e.to_string())?;
        let transfer = transfers.get(id).ok_or("tearout_transfer_missing")?;
        if label != caller || transfer.source != caller || transfer.phase != transfer::Phase::Cleaned { return Err("tearout_transfer_not_complete".into()); }
        if let Some(token) = finalize_token.as_deref() {
            transfer.check_finalize(&caller, token)?;
            if finalize_label.as_deref() != Some(transfer.receiver.as_str()) { return Err("tearout_transfer_receiver_changed".into()); }
        }
    }
    on_ui(&app, move |app| {
        let state = app.state::<TearoutState>();
        let mut transfers = state.transfers.lock().map_err(|e| e.to_string())?;
        if let Some(id) = transfer_id.as_deref() {
            let transfer = transfers.get(id).ok_or("tearout_transfer_missing")?;
            // Recheck on the UI thread and hold through retirement. A timeout
            // can roll back while this closure is queued; never destroy that
            // restored source or unlock its receiver using an earlier check.
            if label != caller || transfer.source != caller || transfer.phase != transfer::Phase::Cleaned {
                return Err("tearout_transfer_not_complete".into());
            }
        }
        app.state::<crate::AppState>()
            .window_registry
            .set_close_intent(&label, true);
        if let Some(window) = app.get_window(&label) {
            if let Err(error) = window.destroy() {
                app.state::<crate::AppState>()
                    .window_registry
                    .set_close_intent(&label, false);
                return Err(error.to_string());
            }
        }
        if let Some(id) = transfer_id {
            if let Some(token) = finalize_token {
                // Retirement succeeded: the source cannot roll back afterward.
                // A live coordinator may retry this finalization on its receipt.
                if let Err(error) = finalize_transfer_entry(&app, &caller, transfers.get_mut(&id).ok_or("tearout_transfer_missing")?, &token) {
                    eprintln!("[tearout] finalize after retirement failed: {error}");
                }
            }
            if transfers.get(&id).is_some_and(|transfer| transfer.can_forget()) { transfers.remove(&id); }
        }
        Ok(())
    })
    .await?;
    if let Some(record) = record {
        if log::tearout_log_record(record.docked().into())
            .await
            .is_err()
        {
            eprintln!("[tearout] log write failed after dock");
        }
    }
    if let Some((receiver, token)) = receipt_label.zip(receipt_token) {
        app.emit_to(
            receiver,
            "mycmux://tearout-receipt",
            serde_json::json!({ "token": token, "ok": true }),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn tearout_settle(app: AppHandle, label: String) -> Result<(), String> {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, label);
        Ok(())
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        on_ui(&app, move |app| {
            if let Some(window) = app.get_window(&label) {
                native::set_alpha(&window, 255)?;
                #[cfg(target_os = "windows")]
                window.set_focus().map_err(|e| e.to_string())?;
                #[cfg(target_os = "macos")]
                window.set_focusable(true).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .await
    }
}

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[cfg_attr(target_os = "windows", derive(PartialEq, Eq))]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[cfg(target_os = "windows")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<SavedPlacement>,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SavedPlacement {
    pub flags: u32,
    pub show_cmd: u32,
    pub min_position: [i32; 2],
    pub max_position: [i32; 2],
    pub normal: [i32; 4],
}

#[cfg(target_os = "windows")]
pub(crate) fn prepare_restored_window(window: &tauri::Window, maximized: bool) -> Result<(), String> {
    native::watch_normal_insets(window)?;
    window.app_handle().state::<TearoutState>().restored_windows.lock().map_err(|e| e.to_string())?
        .insert(window.label().to_owned(), maximized);
    Ok(())
}

/// The six-second boot safety net must use the same quiet saved-state reveal.
#[cfg(target_os = "windows")]
pub(crate) fn reveal_restored_fallback(window: &tauri::Window) -> Result<(), String> {
    let state = window.app_handle().state::<TearoutState>();
    let maximized = state.restored_windows.lock().map_err(|e| e.to_string())?.remove(window.label());
    if let Some(maximized) = maximized {
        if let Err(error) = native::quiet_show(window, maximized) {
            state.restored_windows.lock().map_err(|e| e.to_string())?.insert(window.label().to_owned(), maximized);
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn saved_native_frame(window: &tauri::Window) -> Result<(crate::db::storage::WindowFrameConfig,
    crate::db::storage::WindowFrameConfig, bool), String> {
    native::saved_normal_frame(window)
}

#[cfg(target_os = "windows")]
pub(crate) fn restore_native_frame(window: &tauri::Window, x: f64, y: f64, width: f64, height: f64,
    maximized: bool) -> Result<(), String> {
    native::restore_saved_frame(window, x, y, width, height, maximized)
}

#[tauri::command]
pub async fn tearout_restore_geometry(
    app: AppHandle,
    label: String,
    geometry: WindowGeometry,
) -> Result<(), String> {
    on_ui(&app, move |app| {
        if let Some(window) = app.get_window(&label) {
            #[cfg(target_os = "windows")]
            {
                native::restore_geometry(&window, geometry)?;
                native::set_alpha(&window, 255)?;
            }
            #[cfg(not(target_os = "windows"))]
            {
            window
                .set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::PhysicalSize::new(
                    geometry.width.max(1),
                    geometry.height.max(1),
                ))
                .map_err(|e| e.to_string())?;
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            native::set_alpha(&window, 255)?;
            window.set_focusable(true).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
}


#[cfg(test)]
mod native_start_refusal_tests {
    use super::*;

    #[test]
    fn move_intent_is_explicit_serialized_and_cannot_change_o2() {
        for mode in [MoveMode::Detach, MoveMode::Dock] {
            let owner = MoveState { mode, ..MoveState::default() };
            assert!(owner.require_mode(mode).is_ok());
            let other = if mode == MoveMode::Detach { MoveMode::Dock } else { MoveMode::Detach };
            assert_eq!(owner.require_mode(other).unwrap_err(), "tearout_move_mode_changed");
            assert_eq!(owner.mode, mode);
            assert_eq!(serde_json::to_value(mode).unwrap(), if mode.allows_dock() { "dock" } else { "detach" });
            assert!(serde_json::from_str::<MoveMode>("\"unknown\"").is_err());
        }
    }

    #[test]
    fn provisional_owner_cannot_start_another_move_or_transfer_after_native_end_r2() {
        let configs = vec![serde_json::json!({"panes":[{"tabs":[{"session_id":"pty-1"}]}]})];
        let mut pending = transfer::Transfer::new("A".into(), "B".into(), configs.clone(), "receipt".into(), None);
        pending.phase = transfer::Phase::Cleaned;
        let mut transfers = HashMap::from([("original".into(), pending)]);
        // This check is independent of the closed/removed native MoveState.
        assert!(provisional_move_refusal(&transfers, "B", "B", "second").is_some());
        assert!(provisional_move_refusal(&transfers, "B", "C", "second").is_some());
        assert!(provisional_move_refusal(&transfers, "B", "B", "original").is_some());
        assert!(provisional_move_refusal(&transfers, "A", "B", "original").is_none());
        assert!(transfer_refusal(&transfers, "B", "second", None).is_some());
        assert!(transfer_refusal(&transfers, "C", "second", Some(&configs)).is_some());
        let transfer = transfers.get_mut("original").unwrap();
        assert!(transfer.check_finalize("B", "receipt").is_err()); assert!(transfer.reserved());
        transfer.check_finalize("A", "receipt").unwrap(); transfer.finalized = true;
        assert!(provisional_move_refusal(&transfers, "B", "B", "second").is_none());
        assert!(transfer_refusal(&transfers, "B", "second", Some(&configs)).is_none());
    }

    #[test]
    fn only_authentic_complete_window_regrabs_are_refused_without_touching_the_owner() {
        let owner = Arc::new(MoveState::default());
        *owner.moving_label.lock().unwrap() = Some("child".into());
        *owner.source_label.lock().unwrap() = Some("main".into());
        owner.alpha.store(128, Ordering::Release);
        let moves = HashMap::from([("owner".into(), owner.clone())]);
        let refusal = pre_ownership_regrab_refusal(&moves, "child", "child", "second", true).unwrap().unwrap();
        assert_eq!(serde_json::to_value(refusal).unwrap(), serde_json::json!({
            "kind": "rejected_busy", "pre_ownership": true, "phase": "moving",
            "owner_id": "owner", "source": "main", "label": "child",
        }));
        assert!(pre_ownership_regrab_refusal(&moves, "main", "child", "second", true).unwrap().is_none());
        assert!(pre_ownership_regrab_refusal(&moves, "child", "child", "second", false).unwrap().is_none());
        assert!(pre_ownership_regrab_refusal(&moves, "child", "child", "owner", true).unwrap().is_none());
        assert!(pre_ownership_regrab_refusal(&moves, "other", "other", "second", true).unwrap().is_none());
        assert_eq!(moves.len(), 1);
        assert!(Arc::ptr_eq(moves.get("owner").unwrap(), &owner));
        assert_eq!(owner.alpha.load(Ordering::Acquire), 128);
        assert!(!owner.closed.load(Ordering::Acquire));
        owner.closed.store(true, Ordering::Release);
        assert!(pre_ownership_regrab_refusal(&moves, "child", "child", "second", true).unwrap().is_none());
    }
}
