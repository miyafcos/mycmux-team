use dashmap::DashMap;
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::AppHandle;

use super::monitor::MetadataStore;
use super::session::PtySession;

pub struct SessionManager {
    sessions: DashMap<String, PtySession>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
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
        data_channel: Channel<Vec<u8>>,
        app_handle: AppHandle,
        cwd: Option<String>,
        env: Option<std::collections::HashMap<String, String>>,
        metadata_store: MetadataStore,
    ) -> Result<(), String> {
        let new_channel_id = data_channel.id();
        if self.sessions.contains_key(&session_id) {
            // v0.7.1 diag: idempotent path. The new Channel handle is dropped on
            // the floor; the existing session's forwarder keeps writing to its
            // original channel. v0.7.2 will swap channels instead.
            let age_ms = self
                .sessions
                .get(&session_id)
                .map(|s| s.created_at.elapsed().as_millis())
                .unwrap_or(0);
            eprintln!(
                "[mycmux-diag manager] create_session id={} kind=idempotent age_ms={} new_channel_id={} (dropped)",
                session_id, age_ms, new_channel_id
            );
            return Ok(());
        }

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
