use dashmap::DashMap;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::broadcast;

const SCROLLBACK_CAP: usize = 32 * 1024; // 32 KB

pub struct RemotePtySession {
    child: Mutex<Box<dyn Child + Send + Sync>>,
    #[allow(dead_code)]
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    pub broadcast: broadcast::Sender<Vec<u8>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
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

        let (tx, _) = broadcast::channel::<Vec<u8>>(256);
        let scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAP)));

        let tx_clone = tx.clone();
        let sb_clone = scrollback.clone();

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        // Append to scrollback (ring buffer)
                        if let Ok(mut sb) = sb_clone.lock() {
                            for &byte in &data {
                                if sb.len() >= SCROLLBACK_CAP {
                                    sb.pop_front();
                                }
                                sb.push_back(byte);
                            }
                        }
                        // Broadcast — ignore error (no receivers is OK)
                        let _ = tx_clone.send(data);
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
        })
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

    pub fn get_scrollback(&self) -> Vec<u8> {
        self.scrollback
            .lock()
            .map(|sb| sb.iter().copied().collect())
            .unwrap_or_default()
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

    #[allow(dead_code)] // Reserved for graceful shutdown
    pub fn kill_all(&self) {
        let keys: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for k in keys {
            if let Some((_, s)) = self.sessions.remove(&k) {
                let _ = s.kill();
            }
        }
    }
}
