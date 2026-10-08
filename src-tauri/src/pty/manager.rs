use dashmap::DashMap;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::AppHandle;

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
    pub kind: String,
    pub session_id: String,
    pub agent_pid: u32,
    pub agent_started_at: u64,
    pub from_hook: bool,
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
    trusted_agent_identities: DashMap<String, TrustedAgentIdentity>,
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
        app_handle: AppHandle,
        cwd: Option<String>,
        env: Option<std::collections::HashMap<String, String>>,
        metadata_store: MetadataStore,
        scrollback_dir: Option<&Path>,
        background_only: bool,
        attach_origin: &str,
    ) -> Result<(), String> {
        #[cfg(debug_assertions)]
        let new_channel_id = data_channel.id().to_string();
        let create_lock = self.create_lock_for(&session_id)?;
        let _create_guard = create_lock
            .lock()
            .map_err(|error| format!("Failed to lock create session {session_id}: {error}"))?;
        create_or_reattach(
            &self.sessions,
            session_id.clone(),
            data_channel, background_only,
            |session, data_channel| {
                // A background start races with mounting/clicking in another
                // window. Existing PTYs keep their renderer's channel and epoch.
                let replaced_channel_ids = session.replace_data_channel(data_channel)?;
                crate::watchdog::log_with_memory(format!(
                    "[pty] frontend attach session={session_id} {attach_origin} generation={} old_channel={} new_channel={}",
                    session.frontend_generation(), replaced_channel_ids.0, replaced_channel_ids.1
                ));
                #[cfg(debug_assertions)]
                {
                    let age_ms = session.created_at.elapsed().as_millis();
                    let (old_channel_id, active_channel_id) = replaced_channel_ids;
                    eprintln!(
                        "[mycmux-diag manager] create_session id={} kind=reattach age_ms={} old_channel_id={} new_channel_id={} active_channel_id={}",
                        session_id, age_ms, old_channel_id, new_channel_id, active_channel_id
                    );
                }
                #[cfg(not(debug_assertions))]
                {
                    let _ = replaced_channel_ids;
                }
                // contract-test pin: test_session_restore_agent_kind.py expects this literal early return
                return Ok(());
            },
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
                    app_handle,
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
        Ok(())
    }

    pub(crate) fn remember_requested_conversation(&self, pty: &str, kind: &str, id: &str) {
        self.requested_conversations.entry(pty.to_string()).or_insert_with(|| RequestedConversation { kind: kind.to_string(), id: id.to_string(), created_at: Instant::now(), agent_seen: self.trusted_agent_identities.contains_key(pty) });
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

    pub(crate) fn trusted_agent_identity(&self, pty: &str) -> Option<TrustedAgentIdentity> {
        self.sessions.contains_key(pty).then(|| self.trusted_agent_identities.get(pty).map(|v| v.clone())).flatten()
    }

    pub(crate) fn conversation_history(&self, pty: &str) -> Vec<String> {
        self.conversation_history.get(pty).map(|ids| ids.clone()).unwrap_or_default()
    }

    pub(crate) fn remember_agent_identity(&self, pty: &str, identity: TrustedAgentIdentity) {
        if !self.sessions.contains_key(pty) { return; }
        self.note_agent_seen(pty);
        let mut history = self.conversation_history.entry(pty.to_string()).or_default();
        if !history.contains(&identity.session_id) { history.push(identity.session_id.clone()); }
        if history.len() > 32 { history.remove(0); }
        drop(history);
        if self.sessions.contains_key(pty) { self.trusted_agent_identities.insert(pty.to_string(), identity); }
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

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        self.requested_conversations.remove(session_id);
        self.trusted_agent_identities.remove(session_id);
        if let Some((_, session)) = self.sessions.remove(session_id) {
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
                let _ = session.kill();
                self.prune_create_lock_if_idle(&key);
            }
        }
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
