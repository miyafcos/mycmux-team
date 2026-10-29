//! Opt-in pane tear-out. Every UI mutation is posted from an async command.
mod geometry;
pub(crate) mod attachment_epoch;
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

const SPARE_IDLE_MS: u64 = 3000;
const STALE_OPERATION_MS: u64 = 300000;

#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
enum WarmPreparation<R> {
    Existing(String),
    Reserved { reservation: R, label: String, generation: u64 },
}

#[derive(Default)]
pub struct TearoutState {
    spare: Mutex<Option<(String, bool)>>,
    warming: AtomicBool,
    last_activity_ms: AtomicU64,
    spare_generation: AtomicU64,
    moves: Mutex<HashMap<String, Arc<MoveState>>>,
    transfers: Mutex<HashMap<String, transfer::Transfer>>,
    releases: Mutex<HashMap<String, Arc<ReleaseEscrow>>>,
    #[cfg(target_os = "windows")]
    restored_windows: Mutex<HashMap<String, bool>>,
    #[cfg(target_os = "windows")]
    followers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl TearoutState {
    fn activity(&self) { self.last_activity_ms.store(unix_ms(), Ordering::Release); }

    #[cfg(target_os = "windows")]
    fn replace_follower(&self, label: &str, stop: Arc<AtomicBool>) {
        // Each follower has at most one pending UI tick. A replaced follower's
        // queued tick sees its stop flag before it can move the window.
        let mut followers = self.followers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(previous) = followers.remove(label) { previous.store(true, Ordering::Release); }
        followers.insert(label.to_owned(), stop);
    }

    #[cfg(target_os = "windows")]
    fn stop_follower(&self, label: &str) {
        if let Some(stop) = self.followers.lock().unwrap_or_else(|e| e.into_inner()).remove(label) {
            stop.store(true, Ordering::Release);
        }
    }

    #[cfg(target_os = "windows")]
    fn finish_follower(&self, label: &str, stop: &Arc<AtomicBool>) {
        stop.store(true, Ordering::Release);
        let mut followers = self.followers.lock().unwrap_or_else(|e| e.into_inner());
        if followers.get(label).is_some_and(|current| Arc::ptr_eq(current, stop)) { followers.remove(label); }
    }

    // Called on the async side, before warming or reserving a spare label.
    #[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
    fn check_idle_warm(&self, idle_only: Option<bool>, now: u64, left_held: bool) -> Result<(), String> {
        if idle_only != Some(true) { return Ok(()); }
        if left_held || now.saturating_sub(self.last_activity_ms.load(Ordering::Acquire)) < SPARE_IDLE_MS {
            return Err("tearout_warm_deferred".into());
        }
        // Release this separate lock before taking transfers -> moves.
        if !self.releases.lock().map_err(|e| e.to_string())?.is_empty() {
            return Err("tearout_warm_deferred".into());
        }
        let transfers = self.transfers.lock().map_err(|e| e.to_string())?;
        if transfers.values().any(|transfer| now.saturating_sub(transfer.created_at_ms) <= STALE_OPERATION_MS) {
            return Err("tearout_warm_deferred".into());
        }
        let moves = self.moves.lock().map_err(|e| e.to_string())?;
        if moves.values().any(|movement| {
            let requested = movement.requested_at_ms.load(Ordering::Acquire);
            !movement.closed.load(Ordering::Acquire) && (requested == 0 || now.saturating_sub(requested) <= STALE_OPERATION_MS)
        }) { return Err("tearout_warm_deferred".into()); }
        Ok(())
    }

    #[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
    fn prepare_warm<R>(
        &self,
        idle_only: Option<bool>,
        now: u64,
        left_held: impl FnOnce() -> bool,
        reserve: impl FnOnce() -> Result<R, String>,
        label_of: impl FnOnce(&R) -> String,
    ) -> Result<Option<WarmPreparation<R>>, String> {
        if let Some((label, _)) = self.spare.lock().map_err(|e| e.to_string())?.as_ref() {
            return Ok(Some(WarmPreparation::Existing(label.clone())));
        }
        self.check_idle_warm(idle_only, now, idle_only == Some(true) && left_held())?;
        if self.warming.swap(true, Ordering::AcqRel) {
            return Ok(None);
        }
        let reservation = match reserve() {
            Ok(reservation) => reservation,
            Err(error) => {
                self.warming.store(false, Ordering::Release);
                return Err(error);
            }
        };
        let label = label_of(&reservation);
        let generation = self.spare_generation.load(Ordering::Acquire);
        *self.spare.lock().map_err(|e| e.to_string())? = Some((label.clone(), false));
        Ok(Some(WarmPreparation::Reserved { reservation, label, generation }))
    }
}

/// An idle spare must not keep the app alive or receive crash-rescued work.
pub fn release_idle_after_destroy(app: &AppHandle, dying: &str) {
    expire_releases_for_window(app, dying);
    let state = app.state::<TearoutState>();
    #[cfg(target_os = "windows")]
    state.stop_follower(dying);
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
        #[cfg(target_os = "windows")]
        state.stop_follower(&label);
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
    requested_at_ms: AtomicU64,
    claimed_at_ms: AtomicU64,
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
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    fn native_start_delay_ms(&self) -> Option<u64> {
        let requested = self.requested_at_ms.load(Ordering::Acquire);
        let claimed = self.claimed_at_ms.load(Ordering::Acquire);
        (requested != 0 && claimed != 0).then(|| claimed.saturating_sub(requested))
    }
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
pub async fn get_session_attachment_contexts(
    window: tauri::Window, app: AppHandle, session_ids: Vec<String>,
    existing_only: bool, transfer_token: Option<String>,
) -> Result<Vec<attachment_epoch::AttachmentContext>, String> {
    let proof = attachment_epoch::window_proof(&window);
    crate::util::task::run_blocking("attachment_contexts", move || {
        let app_state = app.state::<crate::AppState>();
        let tearout = app.state::<TearoutState>();
        // Transfer mutex is always outside lifecycle/create/authority locks.
        // Neither swap entrance ever takes this mutex in the opposite order.
        let transfers = tearout.transfers.lock().map_err(|e| e.to_string())?;
        let transfer = match transfer_token.as_deref() {
            Some(token) => Some(transfers.iter().find(|(_, transfer)| transfer.delivery_token == token)
                .ok_or("tearout_transfer_token_changed")?),
            None => None,
        };
        if let Some((_, transfer)) = transfer {
            if transfer.receiver != proof.label || transfer.attachments_revoked || transfer.attachments_revoking
                || !matches!(transfer.phase, transfer::Phase::Committed | transfer::Phase::Received | transfer::Phase::Cleaned)
                || transfer.attachment_receiver.as_ref().is_none_or(|receiver| receiver.incarnation != proof.incarnation) {
                return Err("attachment_transfer_revoked".into());
            }
        }
        let mut unique = std::collections::HashSet::new();
        let mut result = Vec::new();
        for id in session_ids {
            if id.is_empty() || !unique.insert(id.clone()) { return Err("attachment_sessions_invalid".into()); }
            result.push(attachment_epoch::with_lifecycle(&id, || {
                let mut authority = attachment_epoch::registry().lock().map_err(|e| e.to_string())?;
                let existing = app_state.session_manager.is_alive(&id);
                if existing_only && !existing { return Err("tearout_session_not_alive".into()); }
                if let Some((transfer_id, transfer)) = transfer {
                    if !transfer::session_ids(&transfer.configs).contains(&id) || !existing {
                        return Err("attachment_transfer_session_changed".into());
                    }
                    authority.issue(&id, &proof, true, Some((transfer_id, &transfer.delivery_token)))
                } else {
                    if transfers.values().any(|transfer| transfer.reserved() && transfer::session_ids(&transfer.configs).contains(&id)) {
                        return Err("attachment_transfer_reserved".into());
                    }
                    authority.require_owner(&id, &proof, existing, published_session_owner(&app_state, &proof.label, &id))?;
                    authority.issue(&id, &proof, existing_only || existing, None)
                }
            })?);
        }
        Ok(result)
    }).await
}

/// Hand attachment ownership of released workspaces to the receiving window.
/// Called by `release_workspaces` and the crash rescue before `window-adopt` is
/// emitted, so the receiver's first mount is not refused as `attachment_owner_changed`.
pub(crate) fn adopt_released_attachments(app: &AppHandle, to_label: &str, configs: &[serde_json::Value]) -> Result<(), String> {
    let window = app.get_window(to_label).ok_or("attachment_receiver_missing")?;
    let proof = attachment_epoch::window_proof(&window);
    for id in transfer::session_ids(configs) {
        attachment_epoch::with_lifecycle(&id, || {
            attachment_epoch::registry().lock().map_err(|e| e.to_string())?.adopt_released(&id, &proof);
            Ok(())
        })?;
    }
    Ok(())
}

fn published_session_owner(state: &crate::AppState, label: &str, id: &str) -> bool {
    state.window_registry.fragment(label).is_some_and(|fragment| fragment.workspaces.iter().any(|config| {
        crate::window_registry::workspace_config_id(config).is_some_and(|workspace_id|
            state.window_registry.window_for_workspace(&workspace_id).as_deref() == Some(label))
            && transfer::session_ids(std::slice::from_ref(config)).contains(id)
    }))
}

fn revoke_transfer_attachments(manager: &crate::pty::manager::SessionManager, id: &str,
    transfer: &mut transfer::Transfer,
) -> Result<(), String> {
    if transfer.attachments_revoked { return Ok(()); }
    if transfer.finalized { return Err("tearout_transfer_finalized".into()); }
    transfer.attachments_revoking = true;
    let source = transfer.attachment_source.as_ref().ok_or("attachment_source_missing")?;
    let mut ids: Vec<_> = transfer::session_ids(&transfer.configs).into_iter().collect();
    ids.sort();
    for session_id in ids {
        attachment_epoch::with_lifecycle(&session_id, || manager.revoke_attachment(&session_id, id, source))?;
    }
    // Context issuance and ack remain blocked on the transfer mutex until
    // every session, including an already-swapped receiver, is retired.
    transfer.attachments_revoked = true;
    attachment_epoch::registry().lock().map_err(|e| e.to_string())?.remember_revoked(&transfer.delivery_token);
    Ok(())
}

#[tauri::command]
pub async fn tearout_revoke_attachments(window: tauri::Window, app: AppHandle, token: String) -> Result<(), String> {
    let caller = window.label().to_owned();
    crate::util::task::run_blocking("revoke_attachments", move || {
        let state = app.state::<TearoutState>();
        let mut transfers = state.transfers.lock().map_err(|e| e.to_string())?;
        let Some((id, transfer)) = transfers.iter_mut().find(|(_, transfer)| transfer.delivery_token == token) else {
            return if attachment_epoch::registry().lock().map_err(|e| e.to_string())?.was_revoked(&token) { Ok(()) }
                else { Err("tearout_transfer_missing".into()) };
        };
        if caller != transfer.receiver { transfer.authorize(&caller)?; }
        revoke_transfer_attachments(&app.state::<crate::AppState>().session_manager, id, transfer)
    }).await
}

// This is the command's actual worker path; the test barrier precedes the
// lifecycle gate so a delayed real request cannot rely on its entry-time check.
fn tearout_attach_existing(manager: &crate::pty::manager::SessionManager, id: &str,
    window: &attachment_epoch::WindowProof, context: &attachment_epoch::AttachmentContext,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<attachment_epoch::AttachmentContext, String> {
    #[cfg(test)]
    attachment_tests::before_gate(id);
    attachment_epoch::with_lifecycle(id, || {
        manager.attach_existing(id, window, context, channel)?;
        Ok(context.clone())
    })
}

#[tauri::command]
pub async fn tearout_attach(
    window: tauri::Window,
    state: State<'_, crate::AppState>,
    session_id: String,
    on_data: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    attachment_context: attachment_epoch::AttachmentContext,
) -> Result<attachment_epoch::AttachmentContext, String> {
    let app = window.app_handle().clone();
    let proof = attachment_epoch::window_proof(&window);
    let _ = state;
    crate::util::task::run_blocking("tearout_attach", move || {
        let state = app.state::<crate::AppState>();
        if state.window_registry.is_closing(&proof.label) || app.get_window(&proof.label).is_none() {
            return Err("tearout_attachment_window_closed".into());
        }
        // Notice state is published within the same lifecycle boundary as
        // the authenticated channel swap; it cannot revive a rejected attach.
        let result = tearout_attach_existing(&state.session_manager, &session_id, &proof, &attachment_context, on_data)?;
        attachment_epoch::with_lifecycle(&session_id, || {
            let authority = attachment_epoch::registry().lock().map_err(|e| e.to_string())?;
            authority.validate(&session_id, &proof, &attachment_context, true)?;
            crate::commands::terminal::invalidate_codex_restore_notice(&app, &session_id);
            let epoch = state.session_manager.session_observation(&session_id).map(|value| value.0);
            crate::commands::terminal::publish_codex_restore_epoch(&app, &session_id, epoch);
            Ok(())
        })?;
        Ok(result)
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
    let source_proof = attachment_epoch::window_proof(&window);
    let receiver_proof = attachment_epoch::window_proof(&app.get_window(&receiver).ok_or("tearout_receiver_unavailable")?);
    let _ = state;
    crate::util::task::run_blocking("tearout_prepare", move || {
        let state = app.state::<TearoutState>();
        let app_state = app.state::<crate::AppState>();
        let mut transfers = state.transfers.lock().map_err(|e| e.to_string())?;
        if transfers.contains_key(&id) || transfers.values().any(|entry| entry.delivery_token == delivery_token) {
            return Err("tearout_transfer_duplicate".into());
        }
        if let Some(refusal) = transfer_refusal(&transfers, &source_proof.label, &id, Some(&configs)) { return Ok(Some(refusal)); }
        for session_id in transfer::session_ids(&configs) {
            attachment_epoch::with_lifecycle(&session_id, || {
                attachment_epoch::registry().lock().map_err(|e| e.to_string())?.require_owner(
                    &session_id, &source_proof, app_state.session_manager.is_alive(&session_id),
                    published_session_owner(&app_state, &source_proof.label, &session_id))
            })?;
        }
        let mut transfer = transfer::Transfer::new(source_proof.label.clone(), receiver, configs, delivery_token, finalizer);
        transfer.attachment_source = Some(source_proof);
        transfer.attachment_receiver = Some(receiver_proof);
        transfers.insert(id, transfer);
        state.activity();
        Ok(None)
    }).await
}

#[tauri::command]
pub async fn tearout_phase(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, TearoutState>,
    id: String,
    phase: transfer::Phase,
) -> Result<bool, String> {
    let caller = window.label().to_owned();
    let _ = state;
    crate::util::task::run_blocking("tearout_phase", move || {
        let state = app.state::<TearoutState>();
        let mut transfers = state.transfers.lock().map_err(|e| e.to_string())?;
        let transfer = transfers.get_mut(&id).ok_or("tearout_transfer_missing")?;
        transfer.authorize(&caller)?;
        let app_state = app.state::<crate::AppState>();
        if phase == transfer::Phase::RolledBack { revoke_transfer_attachments(&app_state.session_manager, &id, transfer)?; }
        if !transfer.advance(phase)? { return Ok(false); }
        state.activity();
        if phase == transfer::Phase::Cleaned {
            let receiver = transfer.attachment_receiver.as_ref().ok_or("attachment_receiver_missing")?;
            for session_id in transfer::session_ids(&transfer.configs) {
                attachment_epoch::with_lifecycle(&session_id, || {
                    attachment_epoch::registry().lock().map_err(|e| e.to_string())?.finalize_owner(&session_id, receiver);
                    Ok(())
                })?;
            }
        }
        if phase == transfer::Phase::Committed {
            app_state.window_registry.queue_adoption(&transfer.receiver, transfer.configs.clone());
        } else if matches!(phase, transfer::Phase::Received | transfer::Phase::RolledBack) {
            let ids = crate::window_registry::workspace_config_ids(&transfer.configs);
            app_state.window_registry.remove_pending_adoption(&transfer.receiver, &ids);
        }
        Ok(true)
    }).await
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
    #[cfg(target_os = "windows")]
    state.stop_follower(&label);
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
    idle_only: Option<bool>,
) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, state, idle_only);
        return Ok(None);
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        #[cfg(target_os = "windows")]
        let left_held = native::left_button_down;
        #[cfg(not(target_os = "windows"))]
        let left_held = || false;
        let (reservation, label, generation) = match state.prepare_warm(
            idle_only, unix_ms(), left_held,
            || match crate::commands::window::resolve_child_window_label(&app, None) {
                Ok(crate::commands::window::ResolvedChildWindow::New(reservation)) => Ok(reservation),
                other => Err(format!("Fresh tear-out reservation failed: {other:?}")),
            },
            |reservation| reservation.label().to_owned(),
        )? {
            Some(WarmPreparation::Existing(label)) => return Ok(Some(label)),
            Some(WarmPreparation::Reserved { reservation, label, generation }) => (reservation, label, generation),
            None => return Ok(None),
        };
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
        state.activity();
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
        #[cfg(target_os = "windows")]
        state.stop_follower(&label);
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
    app.state::<TearoutState>().activity();
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
    refusal_source: &'static str,
}
impl NativeStartRefusal {
    fn moving(owner_id: &str, source: &str, label: &str) -> Self {
        Self { kind: "rejected_busy", pre_ownership: true, phase: "moving",
            owner_id: owner_id.into(), source: source.into(), label: label.into(), refusal_source: "backend_pre_ownership" }
    }
    fn transfer(owner_id: &str, source: &str, label: &str) -> Self {
        Self { refusal_source: "backend_transfer", ..Self::moving(owner_id, source, label) }
    }
    fn release(owner_id: &str, source: &str, label: &str) -> Self {
        Self { refusal_source: "backend_release", ..Self::moving(owner_id, source, label) }
    }
}

fn transfer_refusal(transfers: &HashMap<String, transfer::Transfer>, requester: &str, id: &str,
    configs: Option<&[serde_json::Value]>) -> Option<NativeStartRefusal> {
    transfers.iter().find(|(owner_id, transfer)| owner_id.as_str() != id &&
        (transfer.reserves_window(requester) || configs.is_some_and(|configs| transfer.reserves_sessions(configs))))
        .map(|(owner_id, transfer)| NativeStartRefusal::transfer(owner_id, &transfer.source, requester))
}

#[tauri::command]
pub async fn tearout_transfer_refusal(window: tauri::Window, state: State<'_, TearoutState>, id: String)
    -> Result<Option<NativeStartRefusal>, String> {
    let _ = id;
    let transfers = state.transfers.lock().map_err(|e| e.to_string())?;
    // An incoming reservation never becomes the child's own operation, even
    // when a caller reuses the source's drag ID.
    Ok(transfers.iter().find(|(_, transfer)| transfer.reserves_window(window.label()))
        .map(|(owner_id, transfer)| NativeStartRefusal::transfer(owner_id, &transfer.source, window.label())))
}

fn provisional_move_refusal(transfers: &HashMap<String, transfer::Transfer>, requester: &str,
    label: &str, id: &str) -> Option<NativeStartRefusal> {
    transfers.iter().find(|(owner_id, transfer)| transfer.reserves_window(requester)
        || (transfer.reserves_window(label) && !(owner_id.as_str() == id && transfer.source == requester)))
        .map(|(owner_id, transfer)| NativeStartRefusal::transfer(owner_id, &transfer.source, label))
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
    #[cfg(target_os = "windows")]
    let _follower = native::FollowerStartGuard::new(&app, &label);
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
        state.activity();
        {
            let releases = state.releases.lock().map_err(|e| e.to_string())?;
            if let Some(release) = releases.values().find(|release| release.pending_for(&label)) {
                if before_ownership && release.frame.id != id {
                    return Ok(Some(NativeStartRefusal::release(&release.frame.id, &release.frame.source, &label)));
                }
                return Err("tearout_release_pending".into());
            }
        }
        let grab_offset = if mode == MoveMode::Detach && regrab != Some(true) && source != label {
            offset_x.zip(offset_y).map(|(x, y)| geometry::GrabOffset { x, y })
        } else { None };
        let shared = Arc::new(MoveState { mode, grab_offset, ..MoveState::default() });
        shared.requested_at_ms.store(unix_ms(), Ordering::Release);
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
            shared.claimed_at_ms.store(unix_ms(), Ordering::Release);
            #[cfg(target_os = "windows")]
            app.state::<TearoutState>().stop_follower(&label);
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

async fn retire_with_record(
    retirement: impl std::future::Future<Output = Result<(), String>>,
    record: Option<serde_json::Value>,
) -> Result<(), String> {
    retirement.await?;
    if let Some(value) = record {
        match serde_json::from_value::<log::DragRecord>(value) {
            Ok(record) => {
                if log::write_record(record.docked().into()).await.is_err() {
                    eprintln!("[tearout] log write failed after dock");
                }
            }
            Err(_) => eprintln!("[tearout] invalid dock record discarded after retirement"),
        }
    }
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
    record: Option<serde_json::Value>,
) -> Result<(), String> {
    let caller = window.label().to_owned();
    #[cfg(target_os = "windows")]
    app.state::<TearoutState>().stop_follower(&label);
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
    retire_with_record(on_ui(&app, move |app| {
        let state = app.state::<TearoutState>();
        state.activity();
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
    }), record).await?;
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
            #[cfg(target_os = "windows")]
            app.state::<TearoutState>().stop_follower(&label);
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

    #[cfg(target_os = "windows")]
    #[test]
    fn follower_state_replacement_and_stop_preserve_other_labels_and_generations() {
        // These are state helpers; this does not exercise each stopping command.
        let state = TearoutState::default();
        let first = Arc::new(AtomicBool::new(false));
        let next = Arc::new(AtomicBool::new(false));
        let unrelated = Arc::new(AtomicBool::new(false));
        state.replace_follower("child", first.clone());
        state.replace_follower("other", unrelated.clone());
        state.replace_follower("child", next.clone());
        assert!(first.load(Ordering::Acquire));
        state.finish_follower("child", &first); // Old thread exits after a newer reveal.
        assert!(Arc::ptr_eq(state.followers.lock().unwrap().get("child").unwrap(), &next));
        assert!(!next.load(Ordering::Acquire));
        state.stop_follower("child");
        assert!(next.load(Ordering::Acquire));
        assert!(!unrelated.load(Ordering::Acquire));
        assert!(!state.followers.lock().unwrap().contains_key("child"));
        state.finish_follower("other", &unrelated);
        assert!(state.followers.lock().unwrap().is_empty());
    }

    #[test]
    fn native_start_delay_measures_ui_queue_wait_without_an_instant_field() {
        let movement = MoveState::default();
        assert!(movement.native_start_delay_ms().is_none());
        movement.requested_at_ms.store(100, Ordering::Release);
        assert!(movement.native_start_delay_ms().is_none());
        movement.claimed_at_ms.store(5519, Ordering::Release);
        assert_eq!(movement.native_start_delay_ms(), Some(5419));
        movement.claimed_at_ms.store(100, Ordering::Release);
        assert_eq!(movement.native_start_delay_ms(), Some(0));
        movement.claimed_at_ms.store(99, Ordering::Release);
        assert_eq!(movement.native_start_delay_ms(), Some(0));
        for refusal in [NativeStartRefusal::moving("move", "source", "child"),
            NativeStartRefusal::release("release", "source", "child"),
            NativeStartRefusal::transfer("transfer", "source", "child")] {
            let value = serde_json::to_value(refusal).unwrap();
            assert_eq!(value["refusal_source"], format!("backend_{}", match value["owner_id"].as_str().unwrap() {
                "move" => "pre_ownership", other => other,
            }));
        }
    }

    #[test]
    fn idle_warm_gate_preserves_demand_warm_and_does_not_reserve_on_deferral() {
        let state = TearoutState::default();
        let now = 400000;
        state.spare_generation.store(7, Ordering::Release);
        let reservations = std::cell::Cell::new(0);
        state.last_activity_ms.store(now - 2999, Ordering::Release);
        let movement = Arc::new(MoveState::default());
        movement.requested_at_ms.store(now - 4000, Ordering::Release);
        state.moves.lock().unwrap().insert("moving".into(), movement.clone());
        for idle_only in [None, Some(false)] {
            assert!(state.check_idle_warm(idle_only, now, true).is_ok());
        }
        let deferred = || {
            let result = state.prepare_warm(Some(true), now, || false, || {
                reservations.set(reservations.get() + 1);
                Ok("must-not-reserve".to_owned())
            }, Clone::clone);
            assert!(matches!(result, Err(error) if error == "tearout_warm_deferred"));
            assert_eq!(reservations.get(), 0);
            assert!(state.spare.lock().unwrap().is_none());
            assert!(!state.warming.load(Ordering::Acquire));
            // prepare_warm only reads the generation; this guards future changes.
            // Reservation count, spare and warming assertions verify the ordering.
            assert_eq!(state.spare_generation.load(Ordering::Acquire), 7);
        };
        deferred(); // Recent activity.
        state.last_activity_ms.store(now - 3000, Ordering::Release);
        deferred(); // Open move.
        movement.closed.store(true, Ordering::Release);
        assert!(state.check_idle_warm(Some(true), now, false).is_ok());
        movement.closed.store(false, Ordering::Release);
        movement.requested_at_ms.store(now - 300001, Ordering::Release);
        assert!(state.check_idle_warm(Some(true), now, false).is_ok());
        assert_eq!(state.check_idle_warm(Some(true), now, true).unwrap_err(), "tearout_warm_deferred");
        state.transfers.lock().unwrap().insert("pending".into(), transfer::Transfer::new(
            "source".into(), "receiver".into(), vec![], "token".into(), None));
        deferred();
        assert!(state.check_idle_warm(None, now, true).is_ok());
        state.transfers.lock().unwrap().clear();
        let frame = ReleaseFrame { id: "release".into(), mode: MoveMode::Dock, label: "child".into(),
            source: "child".into(), receiver: "main".into(), receiver_epoch: 1, region_count: 1,
            client_x: 0.0, client_y: 0.0, token: "token".into(),
            point: ReleasePoint { x: 0.0, y: 0.0, at: now, method: release::ReleaseMethod::NativeUp } };
        state.releases.lock().unwrap().insert("release".into(), Arc::new(ReleaseEscrow::new(frame)));
        deferred();
        assert!(state.check_idle_warm(None, now, true).is_ok());
    }

    #[test]
    fn idle_warm_gate_ignores_transfers_only_after_the_stale_operation_limit() {
        let state = TearoutState::default();
        let pending = transfer::Transfer::new("source".into(), "receiver".into(), vec![], "token".into(), None);
        let now = unix_ms();
        assert!(pending.created_at_ms <= now);
        state.transfers.lock().unwrap().insert("pending".into(), pending);
        assert_eq!(state.check_idle_warm(Some(true), now, false).unwrap_err(), "tearout_warm_deferred");
        state.transfers.lock().unwrap().get_mut("pending").unwrap().created_at_ms = now - STALE_OPERATION_MS;
        assert_eq!(state.check_idle_warm(Some(true), now, false).unwrap_err(), "tearout_warm_deferred");
        state.transfers.lock().unwrap().get_mut("pending").unwrap().created_at_ms = now - STALE_OPERATION_MS - 1;
        assert!(state.check_idle_warm(Some(true), now, false).is_ok());
    }

    #[test]
    fn demand_warm_reserves_without_consulting_idle_activity_or_the_button() {
        for idle_only in [None, Some(false)] {
            let state = TearoutState::default();
            let now = unix_ms();
            state.last_activity_ms.store(now, Ordering::Release);
            state.transfers.lock().unwrap().insert("pending".into(), transfer::Transfer::new(
                "source".into(), "receiver".into(), vec![], "token".into(), None));
            let reservations = std::cell::Cell::new(0);
            let result = state.prepare_warm(idle_only, now, || panic!("demand warm must not query the button"), || {
                reservations.set(reservations.get() + 1);
                Ok("new-spare".to_owned())
            }, Clone::clone).unwrap();
            assert!(matches!(result, Some(WarmPreparation::Reserved { reservation, label, generation: 0 })
                if reservation == "new-spare" && label == "new-spare"));
            assert_eq!(reservations.get(), 1);
            assert_eq!(*state.spare.lock().unwrap(), Some(("new-spare".into(), false)));
            assert!(state.warming.load(Ordering::Acquire));
        }
    }

    #[test]
    fn existing_spare_returns_its_label_before_the_idle_gate_or_reservation() {
        let state = TearoutState::default();
        *state.spare.lock().unwrap() = Some(("existing".into(), false));
        state.warming.store(true, Ordering::Release);
        state.spare_generation.store(7, Ordering::Release);
        let result = state.prepare_warm::<String>(Some(true), 0, || panic!("must not query the button"),
            || panic!("must not reserve"), |_| panic!("must not extract a reserved label")).unwrap();
        assert!(matches!(result, Some(WarmPreparation::Existing(label)) if label == "existing"));
        assert_eq!(*state.spare.lock().unwrap(), Some(("existing".into(), false)));
        assert!(state.warming.load(Ordering::Acquire));
        // prepare_warm only reads the generation; this guards future changes.
        // Reservation count, spare and warming assertions verify the ordering.
        assert_eq!(state.spare_generation.load(Ordering::Acquire), 7);
    }

    #[test]
    fn warming_spare_returns_none_without_reserving_again() {
        let state = TearoutState::default();
        state.warming.store(true, Ordering::Release);
        let result = state.prepare_warm::<String>(Some(true), 400000, || false,
            || panic!("must not reserve"), |_| panic!("must not extract a reserved label")).unwrap();
        assert!(result.is_none());
        assert!(state.spare.lock().unwrap().is_none());
        assert!(state.warming.load(Ordering::Acquire));
        // prepare_warm only reads the generation; this guards future changes.
        // Reservation count, spare and warming assertions verify the ordering.
        assert_eq!(state.spare_generation.load(Ordering::Acquire), 0);
    }

    #[test]
    fn warm_reservation_failure_clears_warming_without_publishing_a_spare() {
        let state = TearoutState::default();
        let result = state.prepare_warm::<String>(None, 0, || false,
            || Err("reservation failed".into()), Clone::clone);
        assert!(matches!(result, Err(error) if error == "reservation failed"));
        assert!(state.spare.lock().unwrap().is_none());
        assert!(!state.warming.load(Ordering::Acquire));
    }

    #[test]
    fn idle_warm_arguments_demonstrate_the_assumed_tauri_default_camel_case_shape() {
        // This equivalent struct demonstrates reliance on Tauri's default
        // camelCase arguments; it does not exercise the command itself.
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Arguments { idle_only: Option<bool> }
        let args: Arguments = serde_json::from_str(r#"{"idleOnly":true}"#).unwrap();
        assert_eq!(args.idle_only, Some(true));
        assert!(serde_json::from_str::<Arguments>("{}").unwrap().idle_only.is_none());
    }

    #[tokio::test]
    async fn retire_continues_when_diagnostic_record_has_unknown_fields() {
        let mut record = serde_json::json!({
            "drag_id": "drag", "pane_id": "tab", "source_window": "child", "switch_on": true,
            "down_at": 10, "layout_done_at": 0, "result": "docked", "focus_stolen": false, "errors": []
        });
        assert!(serde_json::from_value::<log::DragRecord>(record.clone()).is_ok());
        record["unknown_future_field"] = serde_json::json!("ignored");
        assert!(serde_json::from_value::<log::DragRecord>(record.clone()).is_err());
        let retired = std::sync::atomic::AtomicBool::new(false);
        let result = retire_with_record(async {
            retired.store(true, Ordering::SeqCst);
            Ok(())
        }, Some(record)).await;
        assert!(result.is_ok());
        assert!(retired.load(Ordering::SeqCst));
        let failed = retire_with_record(async { Err("retire_failed".into()) }, None).await;
        assert_eq!(failed.unwrap_err(), "retire_failed");
    }

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
            "refusal_source": "backend_pre_ownership",
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

#[cfg(test)]
mod attachment_tests {
    use super::*;
    use attachment_epoch::{AttachmentContext, WindowProof};
    use crate::pty::manager::SessionManager;
    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;
    use tauri::ipc::{Channel, InvokeResponseBody};

    type Pause = (mpsc::Sender<()>, mpsc::Receiver<()>);
    static PAUSES: OnceLock<Mutex<HashMap<String, Pause>>> = OnceLock::new();
    pub(super) fn before_gate(id: &str) {
        let pause = PAUSES.get_or_init(Default::default).lock().unwrap().remove(id);
        if let Some((reached, resume)) = pause {
            reached.send(()).unwrap(); resume.recv_timeout(Duration::from_secs(10)).unwrap();
        }
    }
    fn pause(id: &str) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (at, reached) = mpsc::channel(); let (resume, wait) = mpsc::channel();
        PAUSES.get_or_init(Default::default).lock().unwrap().insert(id.into(), (at, wait));
        (reached, resume)
    }
    fn fixture(count: usize) -> (Arc<SessionManager>, Vec<String>, WindowProof, WindowProof, transfer::Transfer) {
        let manager = Arc::new(SessionManager::new());
        let source = WindowProof::fixture("T"); let receiver = WindowProof::fixture("R");
        let ids: Vec<_> = (0..count).map(|_| format!("pty-{}", uuid::Uuid::new_v4())).collect();
        for id in &ids {
            manager.install_fixture_owner(id, 101, Duration::ZERO, crate::pty::monitor::new_metadata_store());
            attachment_epoch::registry().lock().unwrap().require_owner(id, &source, true, true).unwrap();
        }
        let config = serde_json::json!({"id":"fixture", "panes":[{"tabs":ids.iter().map(|id| serde_json::json!({"session_id":id})).collect::<Vec<_>>()}]});
        let mut transfer = transfer::Transfer::new(source.label.clone(), receiver.label.clone(), vec![config], uuid::Uuid::new_v4().to_string(), None);
        transfer.attachment_source = Some(source.clone()); transfer.attachment_receiver = Some(receiver.clone());
        transfer.phase = transfer::Phase::Committed;
        (manager, ids, source, receiver, transfer)
    }
    fn issue(id: &str, proof: &WindowProof, transfer: Option<(&str, &str)>) -> AttachmentContext {
        attachment_epoch::with_lifecycle(id, || attachment_epoch::registry().lock().unwrap().issue(id, proof, true, transfer)).unwrap()
    }
    fn channel() -> (Channel<InvokeResponseBody>, Arc<Mutex<Vec<Vec<u8>>>>) {
        let received = Arc::new(Mutex::new(Vec::new())); let sink = received.clone();
        (Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body { sink.lock().unwrap().push(bytes[40..].to_vec()); }
            Ok(())
        }), received)
    }

    #[tokio::test]
    async fn a01_real_tearout_attach_paused_before_gate_cannot_steal_restored_output() {
        let (manager, ids, source, receiver, mut transfer) = fixture(1);
        let id = &ids[0]; let transfer_id = uuid::Uuid::new_v4().to_string();
        let old = issue(id, &receiver, Some((&transfer_id, &transfer.delivery_token)));
        let (reached, resume) = pause(id);
        let late_manager = manager.clone(); let late_id = id.clone(); let late_window = receiver.clone();
        let (old_channel, old_output) = channel();
        let late = std::thread::spawn(move || tearout_attach_existing(&late_manager, &late_id, &late_window, &old, old_channel));
        reached.recv_timeout(Duration::from_secs(10)).unwrap();
        revoke_transfer_attachments(&manager, &transfer_id, &mut transfer).unwrap();
        transfer.advance(transfer::Phase::RolledBack).unwrap();
        let restored = issue(id, &source, None); let (current, output) = channel();
        tearout_attach_existing(&manager, id, &source, &restored, current).unwrap();
        assert!(manager.get(id).unwrap().fixture_output(b"before").await);
        resume.send(()).unwrap(); assert!(late.join().unwrap().is_err());
        assert!(manager.get(id).unwrap().fixture_output(b"after").await);
        assert_eq!(*output.lock().unwrap(), [b"before".to_vec(), b"after".to_vec()]);
        assert!(old_output.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a02_both_swap_orders_revoke_installed_channels_and_reject_forged_contexts() {
        for swap_first in [false, true] {
            let (manager, ids, source, receiver, mut transfer) = fixture(1);
            let id = &ids[0]; let transfer_id = uuid::Uuid::new_v4().to_string();
            let old = issue(id, &receiver, Some((&transfer_id, &transfer.delivery_token)));
            let (old_channel, old_output) = channel();
            if swap_first { tearout_attach_existing(&manager, id, &receiver, &old, old_channel).unwrap(); }
            revoke_transfer_attachments(&manager, &transfer_id, &mut transfer).unwrap();
            if (swap_first) { assert!(!manager.get(id).unwrap().fixture_output(b"revoked").await); }
            assert!(tearout_attach_existing(&manager, id, &receiver, &old, channel().0).is_err());
            let restored = issue(id, &source, None);
            for field in ["backend", "nonce", "epoch", "session", "transfer", "incarnation"] {
                let mut forged = restored.clone();
                match field {
                    "backend" => forged.backend_epoch.push('x'), "nonce" => forged.nonce.push('x'),
                    "epoch" => forged.attachment_epoch += 1, "session" => forged.session_id.push('x'),
                    "transfer" => forged.transfer_token = Some("forged".into()), _ => forged.window_incarnation.push('x'),
                }
                assert!(tearout_attach_existing(&manager, id, &source, &forged, channel().0).is_err(), "{field}");
            }
            assert!(tearout_attach_existing(&manager, id, &WindowProof::fixture("T"), &restored, channel().0).is_err());
            let (current, output) = channel(); tearout_attach_existing(&manager, id, &source, &restored, current).unwrap();
            assert!(manager.get(id).unwrap().fixture_output(b"restored").await);
            assert_eq!(*output.lock().unwrap(), [b"restored".to_vec()]);
            assert!(old_output.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn a02_multi_session_cancellation_ack_waits_for_every_gate_and_gc_keeps_revocations() {
        let (manager, mut ids, source, receiver, mut transfer) = fixture(2);
        ids.sort(); let transfer_id = uuid::Uuid::new_v4().to_string();
        let contexts: Vec<_> = ids.iter().map(|id| issue(id, &receiver, Some((&transfer_id, &transfer.delivery_token)))).collect();
        tearout_attach_existing(&manager, &ids[0], &receiver, &contexts[0], channel().0).unwrap();
        let gate = crate::commands::terminal::codex_restore_lifecycle_gate(&ids[1]); let held = gate.lock().unwrap();
        let (ack, acknowledged) = mpsc::channel(); let worker = manager.clone(); let key = transfer_id.clone();
        let cancellation = std::thread::spawn(move || {
            let result = revoke_transfer_attachments(&worker, &key, &mut transfer);
            ack.send(result).unwrap(); transfer
        });
        assert!(acknowledged.recv_timeout(Duration::from_millis(50)).is_err());
        drop(held); acknowledged.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
        assert!(cancellation.join().unwrap().attachments_revoked);
        // The Transfer has been dropped, exactly as after tearout_forget.
        for (id, old) in ids.iter().zip(contexts) {
            assert!(tearout_attach_existing(&manager, id, &receiver, &old, channel().0).is_err());
            let restored = issue(id, &source, None);
            tearout_attach_existing(&manager, id, &source, &restored, channel().0).unwrap();
        }
    }

    #[tokio::test]
    async fn a03_existing_create_session_uses_the_same_swap_authority_and_never_spawns() {
        let (manager, ids, source, receiver, mut transfer) = fixture(1);
        let id = &ids[0]; let transfer_id = uuid::Uuid::new_v4().to_string();
        let old = issue(id, &receiver, Some((&transfer_id, &transfer.delivery_token)));
        revoke_transfer_attachments(&manager, &transfer_id, &mut transfer).unwrap();
        let restored = issue(id, &source, None);
        let before = manager.iter_pids();
        // Exercise the real create() entry used by create_session, including
        // its existing-PTY decision and create lock. A native AppHandle is
        // needed only for spawn, which must remain unreachable in this test.
        let create = |window: &WindowProof, context: &AttachmentContext, channel| {
            attachment_epoch::with_lifecycle(id, || manager.create(
                id.clone(), "must-not-spawn", &[], 80, 24, channel,
                || panic!("existing PTY must never request a spawn AppHandle"),
                None, None, crate::pty::monitor::new_metadata_store(), None,
                false, "A03-create-session", context, window,
            ))
        };
        let (current, output) = channel();
        create(&source, &restored, current).unwrap();
        assert!(manager.get(id).unwrap().fixture_output(b"before-old-create").await);
        let (late, rejected_output) = channel();
        assert!(create(&receiver, &old, late).is_err());
        assert!(manager.get(id).unwrap().fixture_output(b"after-old-create").await);
        assert_eq!(*output.lock().unwrap(), [b"before-old-create".to_vec(), b"after-old-create".to_vec()]);
        assert!(rejected_output.lock().unwrap().is_empty());
        assert_eq!(manager.iter_pids(), before);
    }

    #[test]
    fn a03_normal_mount_requires_current_owner_and_existing_grants_cannot_respawn() {
        let (manager, ids, source, _, _) = fixture(1); let id = &ids[0];
        let context = issue(id, &source, None);
        let mut authority = attachment_epoch::registry().lock().unwrap();
        assert!(authority.require_owner(id, &WindowProof::fixture("other"), true, false).is_err());
        assert!(authority.validate(id, &source, &context, false).is_err());
        let mut unknown = context.clone(); unknown.session_id = "unknown".into();
        assert!(authority.validate("unknown", &source, &unknown, true).is_err());
        drop(authority);
        assert_eq!(manager.iter_pids().len(), 1);
    }

    #[test]
    fn a03_released_workspace_moves_ownership_to_the_live_receiver() {
        // Dock-back (`release_workspaces`) while the child window is still live.
        let (manager, ids, child, _, _) = fixture(1); let id = &ids[0];
        let stale = issue(id, &child, None);
        let main = WindowProof::fixture("main");
        let mut authority = attachment_epoch::registry().lock().unwrap();
        assert_eq!(authority.require_owner(id, &main, true, false).unwrap_err(), "attachment_owner_changed");
        authority.adopt_released(id, &main);
        assert!(authority.require_owner(id, &main, true, false).is_ok());
        let fresh = authority.issue(id, &main, true, None).unwrap();
        assert!(authority.validate(id, &main, &fresh, true).is_ok());
        assert!(authority.validate(id, &child, &stale, true).is_err(), "releasing window keeps no grant");
        assert!(authority.require_owner(id, &child, true, false).is_err());
        drop(authority);
        assert_eq!(manager.iter_pids().len(), 1);
    }
}
