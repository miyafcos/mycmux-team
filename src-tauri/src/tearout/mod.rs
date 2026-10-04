//! Opt-in pane tear-out. Every UI mutation is posted from an async command.
mod geometry;
pub mod log;
#[cfg(target_os = "windows")]
mod native;
#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod native;
mod performance;
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
}

/// An idle spare must not keep the app alive or receive crash-rescued work.
pub fn release_idle_after_destroy(app: &AppHandle, dying: &str) {
    let state = app.state::<TearoutState>();
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
}

#[derive(Default)]
pub struct MoveState {
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
    applied_alpha: AtomicU8,
    alpha_calls: AtomicU64,
    sample_count: AtomicU64,
    receiver_epoch: AtomicU64,
    preview_revision: AtomicU64,
    region_count: AtomicU64,
    pacing: Mutex<performance::SamplePacer>,
    metrics: performance::NativeMetrics,
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
        let source = source_label.unwrap_or_else(|| window.label().to_owned());
        on_ui(&app, move |app| {
            native::synthetic_sample(
                &app,
                id,
                label,
                source,
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
        let source = source_label.unwrap_or_else(|| window.label().to_owned());
        on_ui(&app, move |app| {
            native::synthetic_sample(
                &app,
                id,
                label,
                source,
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
    if state.window_registry.is_closing(window.label())
        || window.app_handle().get_window(window.label()).is_none()
    {
        return Err("tearout_attachment_window_closed".into());
    }
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or("tearout_session_not_alive")?;
    session.replace_data_channel(on_data).map(|_| ())
}

#[tauri::command]
pub async fn tearout_prepare(
    app: AppHandle,
    state: State<'_, TearoutState>,
    id: String,
    receiver: String,
    configs: Vec<serde_json::Value>,
) -> Result<(), String> {
    if app.get_window(&receiver).is_none()
        || app
            .state::<crate::AppState>()
            .window_registry
            .is_closing(&receiver)
    {
        return Err("tearout_receiver_unavailable".into());
    }
    if configs.is_empty()
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
    transfers.insert(id, transfer::Transfer::new(receiver, configs));
    Ok(())
}

#[tauri::command]
pub async fn tearout_phase(
    app: AppHandle,
    state: State<'_, TearoutState>,
    id: String,
    phase: transfer::Phase,
) -> Result<bool, String> {
    let mut transfers = state.transfers.lock().map_err(|e| e.to_string())?;
    let transfer = transfers.get_mut(&id).ok_or("tearout_transfer_missing")?;
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

#[tauri::command]
pub async fn tearout_forget(state: State<'_, TearoutState>, id: String) -> Result<(), String> {
    state
        .transfers
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    Ok(())
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
            let window = tauri::WebviewWindowBuilder::new(
                &app,
                reservation.label(),
                tauri::WebviewUrl::default(),
            )
            .title("mycmux")
            .decorations(false)
            .resizable(true)
            .visible(false)
            .focused(false)
            .inner_size(720.0, 520.0)
            .min_inner_size(240.0, 160.0)
            .initialization_script("window.__MYCMUX_TEAROUT_WINDOW__ = true;")
            .build()
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
    window: tauri::Window,
    state: State<'_, TearoutState>,
) -> Result<(), String> {
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
) -> Result<Reveal, String> {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, label, offset_x, offset_y);
        Err("Native pane tear-out is Windows-only".into())
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        on_ui(&app, move |app| {
            native::reveal(&app, &label, offset_x, offset_y)
        })
        .await
    }
}

#[tauri::command]
pub async fn tearout_start_move(
    window: tauri::Window,
    app: AppHandle,
    label: String,
    id: String,
    region_count: Option<usize>,
) -> Result<(), String> {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, window, label, id, region_count);
        Err("Native pane tear-out is Windows-only".into())
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let shared = Arc::new(MoveState::default());
        shared
            .region_count
            .store(region_count.unwrap_or(1).max(1) as u64, Ordering::Release);
        app.state::<TearoutState>()
            .moves
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), shared.clone());
        let key = id.clone();
        let source = window.label().to_owned();
        let result = on_ui(&app, move |app| {
            native::start(&app, &label, source, id, shared)
        })
        .await;
        if result.is_err() {
            app.state::<TearoutState>()
                .moves
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&key);
        }
        result
    }
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
    if shared.closed.load(Ordering::Acquire) {
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
    app: AppHandle,
    label: String,
    receipt_label: Option<String>,
    receipt_token: Option<String>,
    transfer_id: Option<String>,
    finalize_label: Option<String>,
    finalize_token: Option<String>,
    record: Option<log::DragRecord>,
) -> Result<(), String> {
    on_ui(&app, move |app| {
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
            app.state::<TearoutState>()
                .transfers
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&id);
        }
        if let Some((receiver, token)) = finalize_label.zip(finalize_token) {
            let _ = app.emit_to(
                receiver,
                "mycmux://tearout-finalize",
                serde_json::json!({ "token": token }),
            );
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
                window.set_focusable(true).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .await
    }
}

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn tearout_restore_geometry(
    app: AppHandle,
    label: String,
    geometry: WindowGeometry,
) -> Result<(), String> {
    on_ui(&app, move |app| {
        if let Some(window) = app.get_window(&label) {
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
        Ok(())
    })
    .await
}
