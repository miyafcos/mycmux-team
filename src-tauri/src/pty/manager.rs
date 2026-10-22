use dashmap::DashMap;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::AppHandle;
use crate::tearout::attachment_epoch::{self, AttachmentContext, WindowProof};

use super::monitor::MetadataStore;
use super::scrollback_store;
use super::session::{PtySession, ScrollbackCursor, ScrollbackSnapshot};

#[derive(Debug, PartialEq, Eq)]
enum CreateDisposition {
    Reattached,
    BackgroundExisting,
    Spawned,
}

fn create_or_reattach<S, T>(
    sessions: &DashMap<String, S>,
    session_id: String,
    resource: T,
    background_only: bool,
    reattach: impl FnOnce(&S, T) -> Result<(), String>,
    spawn: impl FnOnce(T) -> Result<S, String>,
) -> Result<CreateDisposition, String> {
    if let Some(session) = sessions.get(&session_id) {
        if background_only { return Ok(CreateDisposition::BackgroundExisting); }
        reattach(session.value(), resource)?;
        return Ok(CreateDisposition::Reattached);
    }

    let session = spawn(resource)?;
    sessions.insert(session_id, session);
    Ok(CreateDisposition::Spawned)
}

fn session_is_running<S>(
    sessions: &DashMap<String, S>,
    session_id: &str,
    poll_exited: impl FnOnce(&S) -> bool,
) -> bool {
    sessions
        .get(session_id)
        .is_some_and(|session| !poll_exited(session.value()))
}

#[derive(Clone, Debug)]
pub(crate) struct TrustedAgentIdentity {
    pub session_epoch: u64,
    pub kind: String,
    pub session_id: String,
    pub agent_pid: u32,
    pub agent_started_at: u64,
    pub from_hook: bool,
}


#[derive(Clone)]
struct SavedAgentIdentity {
    session_epoch: u64,
    revision: u64,
    identity: Option<TrustedAgentIdentity>,
    trusted: bool,
}

/// Only the monitor can use suspended evidence to re-prove process ownership.
/// Naming consumers continue to receive active identities only.
#[derive(Clone)]
pub(crate) struct AgentIdentitySnapshot {
    session_epoch: u64,
    revision: u64,
    trusted: bool,
    identity: Option<TrustedAgentIdentity>,
}

fn identity_kind_matches(saved: &str, live: &str) -> bool {
    saved == live || matches!((saved, live), ("claude-codex", "claude") | ("claude", "claude-codex"))
}

impl AgentIdentitySnapshot {
    pub(crate) fn hook_for_process(&self, kind: &str, pid: u32, started_at: u64) -> Option<TrustedAgentIdentity> {
        self.identity.as_ref().filter(|identity| identity.from_hook
            && identity.session_epoch == self.session_epoch && identity_kind_matches(&identity.kind, kind)
            && pid > 0 && started_at > 0 && identity.agent_pid == pid && identity.agent_started_at == started_at).cloned().map(|mut identity| {
                if kind == "claude-codex" { identity.kind = kind.to_string(); }
                identity
            })
    }

    fn hook_for_metadata(&self, metadata: &super::monitor::PtyMetadata) -> Option<TrustedAgentIdentity> {
        if self.trusted { return None; }
        self.identity.as_ref().filter(|identity| identity.from_hook && identity_matches_metadata(identity, metadata)).cloned()
    }
}

fn identity_matches_metadata(identity: &TrustedAgentIdentity, metadata: &super::monitor::PtyMetadata) -> bool {
    identity.session_epoch == metadata.session_epoch && identity.agent_pid > 0
        && metadata.agent_pid == Some(identity.agent_pid) && identity.agent_started_at > 0
        && metadata.agent_started_at.is_some() && identity.agent_started_at.checked_mul(1_000) == metadata.agent_started_at
        && metadata.live_agent_kind.as_deref().is_some_and(|kind| identity_kind_matches(&identity.kind, kind))
}

struct RequestedConversation {
    kind: String, id: String, created_at: Instant, agent_seen: bool,
}

fn requested_launch_is_pending(agent_seen: bool, elapsed: std::time::Duration) -> bool {
    !agent_seen && elapsed < std::time::Duration::from_secs(10)
}

pub struct SessionManager {
    sessions: DashMap<String, PtySession>,
    create_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    requested_conversations: DashMap<String, RequestedConversation>,
    trusted_agent_identities: DashMap<String, SavedAgentIdentity>,
    conversation_history: DashMap<String, Vec<String>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            create_locks: Mutex::new(HashMap::new()),
            requested_conversations: DashMap::new(),
            trusted_agent_identities: DashMap::new(),
            conversation_history: DashMap::new(),
        }
    }

    fn create_lock_for(&self, session_id: &str) -> Result<Arc<Mutex<()>>, String> {
        let mut locks = self
            .create_locks
            .lock()
            .map_err(|error| format!("Failed to lock create session map: {error}"))?;
        Ok(locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    fn prune_create_lock_if_idle(&self, session_id: &str) {
        let Ok(mut locks) = self.create_locks.lock() else {
            return;
        };
        let should_remove = locks
            .get(session_id)
            .map(|lock| Arc::strong_count(lock) == 1)
            .unwrap_or(false);
        if should_remove {
            locks.remove(session_id);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        session_id: String,
        command: &str,
        args: &[String],
        cols: u16,
        rows: u16,
        data_channel: Channel<InvokeResponseBody>,
        app_handle: impl FnOnce() -> AppHandle,
        cwd: Option<String>,
        env: Option<std::collections::HashMap<String, String>>,
        metadata_store: MetadataStore,
        scrollback_dir: Option<&Path>,
        background_only: bool,
        _attach_origin: &str,
        attachment_context: &AttachmentContext,
        attachment_window: &WindowProof,
    ) -> Result<(), String> {
        let new_channel_id_value = data_channel.id();
        #[cfg(debug_assertions)]
        let new_channel_id = new_channel_id_value.to_string();
        let create_lock = self.create_lock_for(&session_id)?;
        let _create_guard = create_lock
            .lock()
            .map_err(|error| format!("Failed to lock create session {session_id}: {error}"))?;
        // Caller holds the lifecycle gate. Always acquire create -> authority
        // before a DashMap reference, matching tearout_attach and cancellation.
        if self.sessions.contains_key(&session_id) {
            if background_only { return Ok(()); }
            self.swap_attachment_locked(&session_id, attachment_window, attachment_context, data_channel)?;
            return Ok(());
        }
        {
            let authority = attachment_epoch::registry().lock().map_err(|e| e.to_string())?;
            authority.validate(&session_id, attachment_window, attachment_context, false)?;
        }
        create_or_reattach(
            &self.sessions,
            session_id.clone(),
            data_channel, background_only,
            |_session, _channel| Err("attachment_existing_session_changed".into()),
            |data_channel| {
                crate::perf_timeline::mark("session.scrollback.load.enter", Some(&session_id));
                let preload = scrollback_dir
                    .and_then(|dir| scrollback_store::load(dir, &session_id))
                    .map(|persisted| {
                        let (_, data) = scrollback_store::sanitize_ring_head(
                            persisted.start_offset,
                            &persisted.data,
                        );
                        data.to_vec()
                    })
                    .unwrap_or_default();
                crate::perf_timeline::mark("session.scrollback.load.done", Some(&session_id));
                #[cfg(debug_assertions)]
                eprintln!(
                    "[mycmux-diag manager] create_session id={} kind=new channel_id={}",
                    session_id, new_channel_id
                );
                self.requested_conversations.remove(&session_id);
                self.trusted_agent_identities.remove(&session_id);
                let session = PtySession::spawn(
                    session_id.clone(),
                    command,
                    args,
                    cols,
                    rows,
                    data_channel,
                    app_handle(),
                    cwd,
                    env,
                    metadata_store,
                    Instant::now(),
                    preload,
                )?;
                if background_only { session.set_frontend_visible(false, None); }
                Ok(session)
            },
        )
        .inspect_err(|error| {
            crate::diag_warn!("pty", "create session {session_id} failed: {error}");
        })?;
        attachment_epoch::registry().lock().map_err(|e| e.to_string())?.installed(attachment_context, new_channel_id_value);
        Ok(())
    }

    fn swap_attachment_locked(&self, id: &str, window: &WindowProof, context: &AttachmentContext,
        data_channel: Channel<InvokeResponseBody>,
    ) -> Result<(), String> {
        let mut authority = attachment_epoch::registry().lock().map_err(|e| e.to_string())?;
        let session = self.sessions.get(id).ok_or("tearout_session_not_alive")?;
        authority.validate(id, window, context, true)?;
        let channel_id = data_channel.id();
        session.replace_data_channel(data_channel)?;
        authority.installed(context, channel_id);
        Ok(())
    }
    pub(crate) fn attach_existing(&self, id: &str, window: &WindowProof, context: &AttachmentContext,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<(), String> {
        let lock = self.create_lock_for(id)?;
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        self.swap_attachment_locked(id, window, context, channel)
    }
    pub(crate) fn revoke_attachment(&self, id: &str, transfer_id: &str, source: &WindowProof) -> Result<(), String> {
        let lock = self.create_lock_for(id)?;
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        let mut authority = attachment_epoch::registry().lock().map_err(|e| e.to_string())?;
        if let Some(channel_id) = authority.retire_transfer(id, transfer_id, source) {
            if let Some(session) = self.sessions.get(id) { session.retire_data_channel(channel_id)?; }
        }
        Ok(())
    }

    pub(crate) fn remember_requested_conversation(&self, pty: &str, kind: &str, id: &str) {
        let agent_seen = self.trusted_agent_identities.get(pty).is_some_and(|saved| saved.identity.is_some());
        self.requested_conversations.entry(pty.to_string()).or_insert_with(|| RequestedConversation { kind: kind.to_string(), id: id.to_string(), created_at: Instant::now(), agent_seen });
    }

    pub(crate) fn requested_conversation(&self, pty: &str) -> Option<(String, String)> {
        self.sessions.contains_key(pty).then(|| self.requested_conversations.get(pty).map(|v| (v.kind.clone(), v.id.clone()))).flatten()
    }

    pub(crate) fn pending_requested_conversation(&self, pty: &str) -> Option<(String, String)> {
        self.requested_conversations.get(pty).filter(|value| requested_launch_is_pending(value.agent_seen, value.created_at.elapsed()))
            .map(|value| (value.kind.clone(), value.id.clone()))
    }

    pub(crate) fn note_agent_seen(&self, pty: &str) {
        if let Some(mut value) = self.requested_conversations.get_mut(pty) { value.agent_seen = true; }
    }

    /// Birth of the current PTY, independent of transcript and renderer generations.
    pub(crate) fn session_age(&self, pty: &str) -> Option<std::time::Duration> {
        self.sessions.get(pty).map(|session| session.created_at.elapsed())
    }

    pub(crate) fn trusted_agent_identity(&self, pty: &str) -> Option<TrustedAgentIdentity> {
        let session = self.sessions.get(pty)?;
        if session.poll_exited() {
            self.trusted_agent_identities.remove_if(pty, |_, saved| saved.session_epoch == session.session_epoch());
            return None;
        }
        self.trusted_agent_identities.remove_if(pty, |_, saved| saved.session_epoch != session.session_epoch());
        self.trusted_agent_identities.get(pty).filter(|saved|
            saved.session_epoch == session.session_epoch() && saved.trusted).and_then(|saved| saved.identity.clone())
    }

    pub(crate) fn agent_identity_snapshot(&self, pty: &str) -> Option<AgentIdentitySnapshot> {
        let session = self.sessions.get(pty)?;
        let epoch = session.session_epoch();
        if session.poll_exited() {
            self.trusted_agent_identities.remove_if(pty, |_, saved| saved.session_epoch == epoch);
            return None;
        }
        self.trusted_agent_identities.remove_if(pty, |_, saved| saved.session_epoch != epoch);
        let saved = self.trusted_agent_identities.get(pty).filter(|saved| saved.session_epoch == epoch);
        Some(AgentIdentitySnapshot {session_epoch:epoch, trusted:saved.as_ref().is_some_and(|saved| saved.trusted),
            revision:saved.as_ref().map_or(0, |saved| saved.revision), identity:saved.and_then(|saved| saved.identity.clone())})
    }

    pub(crate) fn conversation_history(&self, pty: &str) -> Vec<String> {
        self.conversation_history.get(pty).map(|ids| ids.clone()).unwrap_or_default()
    }

    fn note_identity(&self, pty: &str, identity: &TrustedAgentIdentity) {
        self.note_agent_seen(pty);
        let mut history = self.conversation_history.entry(pty.to_string()).or_default();
        if !history.contains(&identity.session_id) { history.push(identity.session_id.clone()); }
        if history.len() > 32 { history.remove(0); }
    }

    pub(crate) fn remember_agent_identity(&self, pty: &str, identity: TrustedAgentIdentity) {
        let Some(session) = self.sessions.get(pty) else { return; };
        if session.session_epoch() != identity.session_epoch || session.poll_exited() { return; }
        self.note_identity(pty, &identity);
        let mut saved = self.trusted_agent_identities.entry(pty.to_string()).or_insert_with(|| SavedAgentIdentity {
            session_epoch:identity.session_epoch, revision:0, identity:None, trusted:false,
        });
        saved.session_epoch = identity.session_epoch;
        saved.revision = saved.revision.wrapping_add(1);
        saved.identity = Some(identity); saved.trusted = true;
    }

    /// Atomically validate the observation's revision, update eligibility, and
    /// publish metadata. A self hook arriving after the snapshot always wins.
    pub(crate) fn publish_agent_observation(&self, snapshot: &AgentIdentitySnapshot,
        identity: Option<TrustedAgentIdentity>, mut metadata: super::monitor::PtyMetadata,
        apply: impl FnOnce(super::monitor::PtyMetadata),
    ) -> bool {
        let pty = metadata.session_id.clone();
        let Some(session) = self.sessions.get(&pty) else { return false; };
        if session.session_epoch() != snapshot.session_epoch || metadata.session_epoch != snapshot.session_epoch
            || session.poll_exited() { return false; }
        let mut saved = self.trusted_agent_identities.entry(pty.clone()).or_insert_with(|| SavedAgentIdentity {
            session_epoch:snapshot.session_epoch, revision:0, identity:None, trusted:false,
        });
        if saved.session_epoch != snapshot.session_epoch || saved.revision != snapshot.revision { return false; }
        let identity = identity.filter(|identity| identity_matches_metadata(identity, &metadata))
            .or_else(|| snapshot.hook_for_metadata(&metadata));
        metadata.agent_session_trusted = identity.as_ref().is_some_and(|identity|
            metadata.agent_kind.as_deref() == Some(identity.kind.as_str())
                && metadata.agent_session_id.as_deref() == Some(identity.session_id.as_str()));
        let confirmed = identity.clone();
        if let Some(identity) = identity {
            saved.identity = Some(identity); saved.trusted = true;
        } else {
            // Missing process information suspends the claim. A definite PID,
            // birth or provider mismatch destroys the re-confirmation evidence.
            let replaced = saved.identity.as_ref().is_some_and(|identity|
                metadata.agent_pid.is_some_and(|pid| pid != identity.agent_pid)
                || metadata.agent_started_at.is_some_and(|birth| identity.agent_started_at.checked_mul(1_000) != Some(birth))
                || metadata.live_agent_kind.as_deref().is_some_and(|kind| !identity_kind_matches(&identity.kind, kind)));
            if replaced { saved.identity = None; }
            saved.trusted = false;
        }
        saved.revision = saved.revision.wrapping_add(1);
        apply(metadata);
        drop(saved);
        if let Some(identity) = confirmed { self.note_identity(&pty, &identity); }
        true
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        session.write(data)
    }

    /// Queue exactly one intervention frame only if no other terminal input
    /// has advanced the per-PTY input revision since the expectation was read.
    /// This intentionally does not reuse the renderer data-channel generation.
    pub fn write_intervention_if_revision(
        &self,
        session_id: &str,
        expected_session_epoch: Option<u64>,
        expected_revision: u64,
        data: &[u8],
    ) -> Result<std::sync::mpsc::Receiver<Result<(), String>>, String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        session.write_intervention_if_revision(expected_session_epoch, expected_revision, data)
    }

    pub fn input_revision(&self, session_id: &str) -> Result<u64, String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        Ok(session.input_revision())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        session.resize(cols, rows)
    }

    pub fn ack_frontend_data(&self, session_id: &str, generation: u64, seq: u64, bytes: usize) {
        if let Some(session) = self.sessions.get(session_id) {
            session.ack_frontend_data(generation, seq, bytes);
        }
    }

    pub fn progress_snapshot(&self, session_id: &str) -> Option<(u64, u64)> {
        self.sessions.get(session_id)?.progress_snapshot()
    }

    pub fn set_frontend_visible(&self, session_id: &str, visible: bool, channel_id: Option<u32>) {
        if let Some(session) = self.sessions.get(session_id) {
            session.set_frontend_visible(visible, channel_id);
        }
    }

    pub fn get_scrollback(&self, session_id: &str) -> Result<Vec<u8>, String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        Ok(session.get_scrollback())
    }

    pub fn get_scrollback_snapshot(
        &self, session_id: &str, since: Option<&ScrollbackCursor>,
    ) -> Result<ScrollbackSnapshot, String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        session.get_scrollback_snapshot_since(since)
    }

    pub fn flush_dirty_scrollbacks(&self, dir: &Path) -> Result<(), String> {
        self.flush_scrollbacks(dir, false)
    }

    pub fn flush_all_scrollbacks(&self, dir: &Path) -> Result<(), String> {
        self.flush_scrollbacks(dir, true)
    }

    fn flush_scrollbacks(&self, dir: &Path, force: bool) -> Result<(), String> {
        let mut errors = Vec::new();
        for session in &self.sessions {
            if let Err(error) = session.flush_scrollback(dir, force) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub(crate) fn retire(&self, session_id: &str) -> Option<PtySession> {
        self.requested_conversations.remove(session_id);
        self.trusted_agent_identities.remove(session_id);
        let retired = self.sessions.remove(session_id).map(|(_, session)| session);
        if let Some(session) = &retired { session.observation_owner().retire(); self.prune_create_lock_if_idle(session_id); }
        retired
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        self.requested_conversations.remove(session_id);
        self.trusted_agent_identities.remove(session_id);
        if let Some((_, session)) = self.sessions.remove(session_id) {
            session.observation_owner().retire();
            session.kill()?;
            self.prune_create_lock_if_idle(session_id);
        }
        Ok(())
    }

    pub fn kill_all_for_workspace(&self, workspace_id: &str) {
        let prefix = format!("{workspace_id}-");
        let keys: Vec<String> = self
            .sessions
            .iter()
            .filter(|entry| entry.key().starts_with(&prefix))
            .map(|entry| entry.key().clone())
            .collect();

        for key in keys {
            self.requested_conversations.remove(&key);
            self.trusted_agent_identities.remove(&key);
            if let Some((_, session)) = self.sessions.remove(&key) {
                session.observation_owner().retire();
                let _ = session.kill();
                self.prune_create_lock_if_idle(&key);
            }
        }
    }

    pub fn kill_all(&self) {
        let keys: Vec<String> = self
            .sessions
            .iter()
            .map(|entry| entry.key().clone())
            .collect();
        for key in keys {
            self.requested_conversations.remove(&key);
            self.trusted_agent_identities.remove(&key);
            if let Some((_, session)) = self.sessions.remove(&key) {
                session.observation_owner().retire();
                let _ = session.kill();
                self.prune_create_lock_if_idle(&key);
            }
        }
    }

    pub(crate) fn iter_observations(&self) -> Vec<(String, Option<u32>, super::monitor::ObservationOwner, Option<u64>)> {
        self.sessions.iter().map(|s| (s.key().clone(), s.process_id(), s.observation_owner(), s.last_output_at())).collect()
    }

    pub fn iter_pids(&self) -> Vec<(String, Option<u32>)> {
        self.sessions
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().process_id()))
            .collect()
    }

    pub fn last_output_snapshot(&self) -> HashMap<String, Option<u64>> {
        self.sessions
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().last_output_at()))
            .collect()
    }

    pub fn session_observation(&self, session_id: &str) -> Option<(u64, Option<u64>)> {
        self.sessions
            .get(session_id)
            .map(|session| (session.session_epoch(), session.last_output_at()))
    }

    pub fn intervention_observation(&self, session_id: &str) -> Option<(u64, u64, Option<u32>)> {
        self.sessions.get(session_id).map(|session| {
            (
                session.session_epoch(),
                session.input_revision(),
                session.process_id(),
            )
        })
    }

    /// Get a reference to a session by ID.
    pub fn get(
        &self,
        session_id: &str,
    ) -> Option<dashmap::mapref::one::Ref<'_, String, PtySession>> {
        self.sessions.get(session_id)
    }

    /// True only while a tracked PTY's child has not exited.
    pub fn is_running(&self, session_id: &str) -> bool {
        session_is_running(&self.sessions, session_id, PtySession::poll_exited)
    }

    /// True if a PTY for this session_id is still tracked (i.e. `create()`
    /// would take the reattach branch above instead of spawning a new
    /// process). Uses the same lookup as the reattach check at the top of
    /// `create()` so the two stay in lockstep.
    pub fn is_alive(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn hybrid_reclassification_preserves_exact_hook_identity_and_lifetime_guards() {
        let identity = TrustedAgentIdentity { session_epoch: 7, kind: "claude".into(), session_id: "exact-session".into(),
            agent_pid: 42, agent_started_at: 10, from_hook: true };
        let snapshot = AgentIdentitySnapshot { session_epoch: 7, revision: 1, trusted: false, identity: Some(identity.clone()) };
        let recovered = snapshot.hook_for_process("claude-codex", 42, 10).unwrap();
        assert_eq!(recovered.session_id, "exact-session");
        assert_eq!(recovered.kind, "claude-codex");
        for (kind, pid, started) in [("codex", 42, 10), ("grok", 42, 10), ("claude-codex", 43, 10), ("claude-codex", 42, 11)] {
            assert!(snapshot.hook_for_process(kind, pid, started).is_none());
        }
        let mut metadata = super::super::monitor::PtyMetadata::unobserved("pty".into());
        metadata.session_epoch = 7; metadata.agent_pid = Some(42); metadata.agent_started_at = Some(10_000);
        metadata.live_agent_kind = Some("claude-codex".into());
        assert!(identity_matches_metadata(&identity, &metadata));
        metadata.session_epoch = 8;
        assert!(!identity_matches_metadata(&identity, &metadata));
    }

    struct FakeSession {
        reattach_count: AtomicUsize,
    }

    impl FakeSession {
        fn new() -> Self {
            Self {
                reattach_count: AtomicUsize::new(0),
            }
        }
    }

    #[test]
    fn is_alive_is_false_for_unknown_session() {
        let manager = SessionManager::new();
        assert!(!manager.is_alive("nonexistent-session"));
    }

    #[test]
    fn is_running_distinguishes_missing_live_and_retained_exited_sessions() {
        use std::sync::atomic::AtomicBool;
        let manager = SessionManager::new();
        assert!(!manager.is_running("missing"));

        let sessions = DashMap::new();
        sessions.insert("session".to_string(), AtomicBool::new(false));
        let running = || {
            session_is_running(&sessions, "session", |exited| exited.load(Ordering::Acquire))
        };
        assert!(running());
        sessions
            .get("session")
            .unwrap()
            .store(true, Ordering::Release);
        assert!(!running());
        assert!(sessions.contains_key("session")); // Still available for reattach.
        let disposition = create_or_reattach(
            &sessions,
            "session".to_string(),
            (), false,
            |_, ()| Ok(()),
            |()| panic!("an exited session must never auto-respawn"),
        )
        .unwrap();
        assert_eq!(disposition, CreateDisposition::Reattached);
        sessions.remove("session");
        assert!(!running());
    }

    #[test]
    fn repeated_background_starts_do_not_replace_an_existing_frontend() {
        let sessions = DashMap::new();
        sessions.insert("visible".to_string(), FakeSession::new());
        for _ in 0..50 {
            let disposition = create_or_reattach(
                &sessions, "visible".to_string(), (), true,
                |_, ()| panic!("background startup must not take the renderer channel"),
                |()| panic!("background startup must not respawn the existing PTY"),
            ).unwrap();
            assert_eq!(disposition, CreateDisposition::BackgroundExisting);
        }
        assert_eq!(sessions.get("visible").unwrap().reattach_count.load(Ordering::SeqCst), 0);
        assert_eq!(sessions.len(), 1);
    }

    #[test]
    fn existing_session_reattaches_without_spawning() {
        let sessions = DashMap::new();
        sessions.insert("session".to_string(), FakeSession::new());
        let spawn_count = AtomicUsize::new(0);

        let disposition = create_or_reattach(
            &sessions,
            "session".to_string(),
            (), false,
            |session, ()| {
                session.reattach_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |()| {
                spawn_count.fetch_add(1, Ordering::SeqCst);
                Ok(FakeSession::new())
            },
        )
        .expect("reattach should succeed");

        assert_eq!(disposition, CreateDisposition::Reattached);
        assert_eq!(spawn_count.load(Ordering::SeqCst), 0);
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions
                .get("session")
                .expect("existing session should remain")
                .reattach_count
                .load(Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn bounded_renderer_reloads_reattach_all_existing_sessions_without_spawning_or_losing_output() {
        use crate::watchdog::{RecoveryDecision, ReloadBudget};
        let sessions = DashMap::new();
        for n in 0..20 {
            sessions.insert(format!("pane-{n}"), (FakeSession::new(), format!("retained output {n}")));
        }
        let mut budget = ReloadBudget::default();
        for (attempt, now) in [0, 60_000, 120_000].into_iter().enumerate() {
            budget.failed(1);
            assert_eq!(budget.poll(now), Some(RecoveryDecision::Reload { attempt: attempt + 1, kind: 1 }));
            for n in 0..20 {
                let disposition = create_or_reattach(
                    &sessions, format!("pane-{n}"), (), false,
                    |(session, output), ()| {
                        session.reattach_count.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(output, &format!("retained output {n}"));
                        Ok(())
                    },
                    |()| panic!("renderer recovery must not spawn a replacement PTY"),
                ).unwrap();
                assert_eq!(disposition, CreateDisposition::Reattached);
            }
        }
        budget.failed(2);
        assert_eq!(budget.poll(180_000), Some(RecoveryDecision::GiveUp { kind: 2 }));
        assert_eq!(sessions.len(), 20);
        for session in sessions.iter() {
            assert_eq!(session.0.reattach_count.load(Ordering::SeqCst), 3);
        }
    }

    #[test]
    fn missing_session_spawns_once_and_is_inserted() {
        let sessions = DashMap::new();
        let reattach_count = AtomicUsize::new(0);
        let spawn_count = AtomicUsize::new(0);

        let disposition = create_or_reattach(
            &sessions,
            "session".to_string(),
            (), false,
            |_, ()| {
                reattach_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |()| {
                spawn_count.fetch_add(1, Ordering::SeqCst);
                Ok(FakeSession::new())
            },
        )
        .expect("spawn should succeed");

        assert_eq!(disposition, CreateDisposition::Spawned);
        assert_eq!(reattach_count.load(Ordering::SeqCst), 0);
        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
        assert!(sessions.contains_key("session"));
    }
    #[test]
    fn si_t1_launch_request_bridges_startup_but_never_reclaims_a_shell_after_agent_exit() {
        use std::time::Duration;
        assert!(requested_launch_is_pending(false, Duration::ZERO));
        assert!(requested_launch_is_pending(false, Duration::from_secs(9)));
        assert!(!requested_launch_is_pending(false, Duration::from_secs(10)));
        assert!(!requested_launch_is_pending(true, Duration::ZERO));
        assert!(!requested_launch_is_pending(true, Duration::from_secs(9)));
    }

}

#[cfg(test)]
impl SessionManager {
    pub(crate) fn install_fixture_owner(&self, id: &str, pid: u32, age: std::time::Duration, store: MetadataStore) {
        self.sessions.insert(id.into(), PtySession::fixture_owner(id, pid, age, store));
    }
}
