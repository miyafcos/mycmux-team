use crate::pty::session::{OutputChunk, ScrollbackSnapshot};
use dashmap::DashMap;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::broadcast;

const SCROLLBACK_CAP: usize = 32 * 1024; // 32 KB

static LAST_REMOTE_SESSION_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn next_remote_session_epoch() -> u64 {
    LAST_REMOTE_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed) + 1
}

pub struct RemotePtySession {
    child: Mutex<Box<dyn Child + Send + Sync>>,
    #[allow(dead_code)]
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    pub broadcast: broadcast::Sender<OutputChunk>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
    scrollback_end: Arc<AtomicU64>,
    session_epoch: u64,
}

// All fields behind Mutex — access is serialised.
unsafe impl Sync for RemotePtySession {}

impl RemotePtySession {
    pub fn spawn(
        _session_id: String,
        command: &str,
        args: &[String],
        cols: u16,
        rows: u16,
        cwd: Option<String>,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        let mut cmd = CommandBuilder::new(command);
        cmd.args(args);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "mycmux-remote");

        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {e}"))?;

        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

        let (tx, _) = broadcast::channel::<OutputChunk>(256);
        let scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAP)));
        let scrollback_end = Arc::new(AtomicU64::new(0));

        let tx_clone = tx.clone();
        let sb_clone = scrollback.clone();
        let sb_end_clone = scrollback_end.clone();

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let start = sb_end_clone.load(Ordering::Relaxed);
                        let end = start.saturating_add(data.len() as u64);
                        // Append to scrollback (ring buffer)
                        if let Ok(mut sb) = sb_clone.lock() {
                            sb.extend(data.iter().copied());
                            let overflow = sb.len().saturating_sub(SCROLLBACK_CAP);
                            if overflow > 0 {
                                drop(sb.drain(..overflow));
                            }
                            sb_end_clone.store(end, Ordering::Relaxed);
                        }
                        // Broadcast — ignore error (no receivers is OK)
                        let _ = tx_clone.send(OutputChunk { data, start, end });
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            child: Mutex::new(child),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            broadcast: tx,
            scrollback,
            scrollback_end,
            session_epoch: next_remote_session_epoch(),
        })
    }

    pub fn session_epoch(&self) -> u64 {
        self.session_epoch
    }

    pub fn write_input(&self, data: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|e| format!("Lock: {e}"))?;
        w.write_all(data).map_err(|e| format!("Write: {e}"))?;
        w.flush().map_err(|e| format!("Flush: {e}"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let m = self.master.lock().map_err(|e| format!("Lock: {e}"))?;
        m.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize: {e}"))
    }

    pub fn size(&self) -> Result<(u16, u16), String> {
        let m = self.master.lock().map_err(|e| format!("Lock: {e}"))?;
        let size = m.get_size().map_err(|e| format!("Get size: {e}"))?;
        Ok((size.cols, size.rows))
    }

    pub fn get_scrollback_snapshot(&self) -> ScrollbackSnapshot {
        match self.scrollback.lock() {
            Ok(scrollback) => {
                let data: Vec<u8> = scrollback.iter().copied().collect();
                let end_offset = self.scrollback_end.load(Ordering::Relaxed);
                let start_offset = end_offset.saturating_sub(data.len() as u64);
                ScrollbackSnapshot {
                    data,
                    start_offset,
                    end_offset,
                }
            }
            Err(_) => ScrollbackSnapshot {
                data: Vec::new(),
                start_offset: 0,
                end_offset: 0,
            },
        }
    }

    pub fn kill(&self) -> Result<(), String> {
        let mut child = self.child.lock().map_err(|e| format!("Lock: {e}"))?;
        child.kill().map_err(|e| format!("Kill: {e}"))
    }
}

impl Drop for RemotePtySession {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

pub struct RemoteSessionManager {
    sessions: DashMap<String, RemotePtySession>,
}

impl RemoteSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    /// Get or create the singleton remote session.
    /// For simplicity we keep one session keyed "default".
    pub fn get_or_create(
        &self,
        command: &str,
        args: &[String],
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        let key = "default".to_string();
        if self.sessions.contains_key(&key) {
            return Ok(key);
        }
        let session = RemotePtySession::spawn(key.clone(), command, args, cols, rows, None)?;
        self.sessions.insert(key.clone(), session);
        Ok(key)
    }

    pub fn get(&self, id: &str) -> Option<dashmap::mapref::one::Ref<'_, String, RemotePtySession>> {
        self.sessions.get(id)
    }

    /// Kill every active remote PTY session. Called on app shutdown (quit /
    /// main window destroyed) so remote-spawned child processes do not
    /// outlive the app.
    pub fn kill_all(&self) {
        let keys: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for k in keys {
            if let Some((_, s)) = self.sessions.remove(&k) {
                let _ = s.kill();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_session_epochs_are_monotonic_and_unique() {
        let first = next_remote_session_epoch();
        let second = next_remote_session_epoch();
        assert!(second > first);
        assert_ne!(first, 0);
    }
}
