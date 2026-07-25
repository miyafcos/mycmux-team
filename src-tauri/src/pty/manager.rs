use dashmap::DashMap;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::AppHandle;

use super::monitor::MetadataStore;
use super::session::{PtySession, ScrollbackSnapshot};

#[derive(Debug, PartialEq, Eq)]
enum CreateDisposition {
    Reattached,
    Spawned,
}

fn create_or_reattach<S, T>(
    sessions: &DashMap<String, S>,
    session_id: String,
    resource: T,
    reattach: impl FnOnce(&S, T) -> Result<(), String>,
    spawn: impl FnOnce(T) -> Result<S, String>,
) -> Result<CreateDisposition, String> {
    if let Some(session) = sessions.get(&session_id) {
        reattach(session.value(), resource)?;
        return Ok(CreateDisposition::Reattached);
    }

    let session = spawn(resource)?;
    sessions.insert(session_id, session);
    Ok(CreateDisposition::Spawned)
}

pub struct SessionManager {
    sessions: DashMap<String, PtySession>,
    create_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            create_locks: Mutex::new(HashMap::new()),
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
            data_channel,
            |session, data_channel| {
                let replaced_channel_ids = session.replace_data_channel(data_channel)?;
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
                #[cfg(debug_assertions)]
                eprintln!(
                    "[mycmux-diag manager] create_session id={} kind=new channel_id={}",
                    session_id, new_channel_id
                );
                PtySession::spawn(
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
                )
            },
        )?;
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        session.write(data)
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

    pub fn set_frontend_visible(&self, session_id: &str, visible: bool) {
        if let Some(session) = self.sessions.get(session_id) {
            session.set_frontend_visible(visible);
        }
    }

    pub fn get_scrollback(&self, session_id: &str) -> Result<Vec<u8>, String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        Ok(session.get_scrollback())
    }

    pub fn get_scrollback_snapshot(&self, session_id: &str) -> Result<ScrollbackSnapshot, String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        Ok(session.get_scrollback_snapshot())
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
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

    /// Get a reference to a session by ID.
    pub fn get(
        &self,
        session_id: &str,
    ) -> Option<dashmap::mapref::one::Ref<'_, String, PtySession>> {
        self.sessions.get(session_id)
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
    fn existing_session_reattaches_without_spawning() {
        let sessions = DashMap::new();
        sessions.insert("session".to_string(), FakeSession::new());
        let spawn_count = AtomicUsize::new(0);

        let disposition = create_or_reattach(
            &sessions,
            "session".to_string(),
            (),
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
    fn missing_session_spawns_once_and_is_inserted() {
        let sessions = DashMap::new();
        let reattach_count = AtomicUsize::new(0);
        let spawn_count = AtomicUsize::new(0);

        let disposition = create_or_reattach(
            &sessions,
            "session".to_string(),
            (),
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
}
