use dashmap::DashMap;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::AppHandle;

use super::monitor::MetadataStore;
use super::session::{FrontendDataBatch, PtySession};

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

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        session_id: String,
        command: &str,
        args: &[String],
        cols: u16,
        rows: u16,
        data_channel: Channel<FrontendDataBatch>,
        consumer_id: String,
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
        if let Some(session) = self.sessions.get(&session_id) {
            let replaced_channel_ids = session.replace_data_channel(data_channel, consumer_id)?;
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
            return Ok(());
        }

        #[cfg(debug_assertions)]
        eprintln!(
            "[mycmux-diag manager] create_session id={} kind=new channel_id={}",
            session_id, new_channel_id
        );
        let session = PtySession::spawn(
            session_id.clone(),
            command,
            args,
            cols,
            rows,
            data_channel,
            consumer_id,
            app_handle,
            cwd,
            env,
            metadata_store,
            Instant::now(),
        )?;
        self.sessions.insert(session_id, session);
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

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        if let Some((_, session)) = self.sessions.remove(session_id) {
            session.kill()?;
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
}
