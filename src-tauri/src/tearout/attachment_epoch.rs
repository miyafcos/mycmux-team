//! Backend-issued renderer authority. Attachment epochs are independent of
//! process epochs and FrontendFlow generations; tombstones survive transfer GC.
use std::collections::HashMap;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock};

#[derive(Clone, Debug)]
pub(crate) struct WindowProof {
    pub label: String,
    pub incarnation: String,
    live: Arc<AtomicBool>,
}
impl WindowProof {
    pub fn live(&self) -> bool { self.live.load(Ordering::Acquire) }
    #[cfg(test)]
    pub fn fixture(label: &str) -> Self {
        Self { label: label.into(), incarnation: uuid::Uuid::new_v4().to_string(), live: Arc::new(AtomicBool::new(true)) }
    }
}
pub(crate) fn window_proof(window: &tauri::Window) -> WindowProof {
    static WINDOWS: OnceLock<Mutex<HashMap<String, WindowProof>>> = OnceLock::new();
    let mut windows = WINDOWS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(proof) = windows.get(window.label()).filter(|proof| proof.live()) { return proof.clone(); }
    let live = Arc::new(AtomicBool::new(true));
    let destroyed = live.clone();
    // Register against this exact native Window, before entering any session gate.
    // Reuse of its label after Destroyed receives a new backend incarnation.
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) { destroyed.store(false, Ordering::Release); }
    });
    let proof = WindowProof { label: window.label().into(), incarnation: uuid::Uuid::new_v4().to_string(), live };
    windows.insert(proof.label.clone(), proof.clone());
    proof
}

// The orchestration executable is headless, so it has no native Window.
// This backend-only identity and issuer do not exist in production builds.
#[cfg(feature = "e2e")]
pub(crate) fn e2e_window_proof() -> WindowProof {
    static WINDOW: OnceLock<WindowProof> = OnceLock::new();
    WINDOW.get_or_init(|| WindowProof {
        label: "e2e-codex-restore".into(),
        incarnation: uuid::Uuid::new_v4().to_string(),
        live: Arc::new(AtomicBool::new(true)),
    }).clone()
}

// Caller already holds create_session_blocking's real lifecycle gate. Do not
// take an extra gate before its checkpoints: that would mask lock regressions.
#[cfg(feature = "e2e")]
pub(crate) fn issue_e2e_context(id: &str, window: &WindowProof, existing: bool) -> Result<AttachmentContext, String> {
    let mut authority = registry().lock().map_err(|e| e.to_string())?;
    authority.require_owner(id, window, existing, false)?;
    authority.issue(id, window, existing, None)
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AttachmentContext {
    pub backend_epoch: String,
    pub transfer_id: Option<String>,
    pub transfer_token: Option<String>,
    pub session_id: String,
    pub window_label: String,
    pub window_incarnation: String,
    pub attachment_epoch: u64,
    pub nonce: String,
    pub existing_only: bool,
}
struct ActiveChannel { context: AttachmentContext, id: u32 }
struct Entry {
    owner: WindowProof,
    epoch: u64,
    current: Option<(AttachmentContext, WindowProof)>,
    active: Option<ActiveChannel>,
    spawn_used: bool,
}
impl Entry {
    fn new(owner: WindowProof) -> Self { Self { owner, epoch: 0, current: None, active: None, spawn_used: false } }
}
pub(crate) struct AttachmentRegistry {
    backend_epoch: String,
    entries: HashMap<String, Entry>,
    revoked_tokens: std::collections::HashSet<String>,
}
impl Default for AttachmentRegistry {
    fn default() -> Self { Self { backend_epoch: uuid::Uuid::new_v4().to_string(), entries: HashMap::new(), revoked_tokens: Default::default() } }
}
pub(crate) fn registry() -> &'static Mutex<AttachmentRegistry> {
    static REGISTRY: OnceLock<Mutex<AttachmentRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}
impl AttachmentRegistry {
    pub fn require_owner(&mut self, id: &str, owner: &WindowProof, existing: bool, published_owner: bool) -> Result<(), String> {
        if !owner.live() { return Err("attachment_window_retired".into()); }
        if let Some(entry) = self.entries.get_mut(id) {
            if entry.owner.label == owner.label && entry.owner.incarnation == owner.incarnation { return Ok(()); }
            // Ordinary crash/close adoption needs a backend registry proof and
            // retirement of the previous native incarnation.
            if !entry.owner.live() && published_owner {
                entry.owner = owner.clone(); return Ok(());
            }
            return Err("attachment_owner_changed".into());
        }
        if existing && !published_owner { return Err("attachment_owner_proof_required".into()); }
        self.entries.insert(id.into(), Entry::new(owner.clone()));
        Ok(())
    }
    pub fn issue(&mut self, id: &str, window: &WindowProof, existing_only: bool,
        transfer: Option<(&str, &str)>,
    ) -> Result<AttachmentContext, String> {
        if !window.live() { return Err("attachment_window_retired".into()); }
        let entry = self.entries.get_mut(id).ok_or("attachment_owner_proof_required")?;
        if transfer.is_none() && (entry.owner.label != window.label || entry.owner.incarnation != window.incarnation) {
            return Err("attachment_owner_changed".into());
        }
        entry.epoch = entry.epoch.checked_add(1).ok_or("attachment_epoch_exhausted")?;
        let context = AttachmentContext { backend_epoch: self.backend_epoch.clone(),
            transfer_id: transfer.map(|value| value.0.into()), transfer_token: transfer.map(|value| value.1.into()),
            session_id: id.into(), window_label: window.label.clone(), window_incarnation: window.incarnation.clone(),
            attachment_epoch: entry.epoch, nonce: uuid::Uuid::new_v4().to_string(), existing_only };
        entry.spawn_used = false;
        entry.current = Some((context.clone(), window.clone()));
        Ok(context)
    }
    pub fn validate(&self, id: &str, window: &WindowProof, context: &AttachmentContext, existing: bool) -> Result<(), String> {
        let entry = self.entries.get(id).ok_or("attachment_grant_missing")?;
        let (current, issued_window) = entry.current.as_ref().ok_or("attachment_grant_revoked")?;
        if !window.live() || !issued_window.live() || context != current
            || context.backend_epoch != self.backend_epoch || context.session_id != id
            || context.window_label != window.label || context.window_incarnation != window.incarnation {
            return Err("attachment_context_stale".into());
        }
        if !existing && (context.existing_only || entry.spawn_used) { return Err("attachment_existing_session_required".into()); }
        Ok(())
    }
    pub fn installed(&mut self, context: &AttachmentContext, channel_id: u32) {
        let entry = self.entries.get_mut(&context.session_id).expect("validated attachment");
        entry.spawn_used = true;
        entry.active = Some(ActiveChannel { context: context.clone(), id: channel_id });
    }
    pub fn retire_transfer(&mut self, id: &str, transfer_id: &str, source: &WindowProof) -> Option<u32> {
        let entry = self.entries.entry(id.into()).or_insert_with(|| Entry::new(source.clone()));
        entry.owner = source.clone();
        if entry.current.as_ref().is_some_and(|value| value.0.transfer_id.as_deref() == Some(transfer_id)) {
            entry.current = None;
        }
        if entry.active.as_ref().is_some_and(|active| active.context.transfer_id.as_deref() == Some(transfer_id)) {
            return entry.active.take().map(|active| active.id);
        }
        None
    }
    pub fn remember_revoked(&mut self, token: &str) { self.revoked_tokens.insert(token.into()); }
    pub fn was_revoked(&self, token: &str) -> bool { self.revoked_tokens.contains(token) }
    pub fn finalize_owner(&mut self, id: &str, receiver: &WindowProof) {
        if let Some(entry) = self.entries.get_mut(id) { entry.owner = receiver.clone(); }
    }
    /// Explicit release outside a transfer (dock-back, crash rescue): the
    /// receiving window becomes the owner before it is told to adopt, and any
    /// grant still held by another window is withdrawn so it cannot re-attach.
    pub fn adopt_released(&mut self, id: &str, receiver: &WindowProof) {
        let entry = self.entries.entry(id.into()).or_insert_with(|| Entry::new(receiver.clone()));
        entry.owner = receiver.clone();
        if entry.current.as_ref().is_some_and(|(_, window)| window.label != receiver.label || window.incarnation != receiver.incarnation) {
            entry.current = None;
        }
    }
}

pub(crate) fn with_lifecycle<T>(id: &str, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let gate = crate::commands::terminal::codex_restore_lifecycle_gate(id);
    let _guard = gate.lock().unwrap_or_else(|e| e.into_inner());
    action()
}
