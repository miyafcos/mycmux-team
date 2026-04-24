use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::events;

use super::monitor::{MetadataStore, PtyMetadata};
use super::osc7::Osc7Parser;

use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

const SCROLLBACK_CAP: usize = 32 * 1024; // 32 KB
const FRONTEND_QUEUE_CAP: usize = 64;
const FRONTEND_FLUSH_INTERVAL_MS: u64 = 8;
const FRONTEND_BATCH_MAX_BYTES: usize = 64 * 1024;
const FRONTEND_FULL_RETRY_DELAY_MS: u64 = 1;

pub struct PtySession {
    child: Mutex<Box<dyn Child + Send + Sync>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    pub broadcast: broadcast::Sender<Vec<u8>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
}

// Safety: All fields are behind Mutex, access is serialized.
unsafe impl Sync for PtySession {}

impl PtySession {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
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
        // Keep the legacy TERM_PROGRAM for shell launcher compatibility.
        // The public app name is exposed separately via MYCMUX_TERM_PROGRAM.
        cmd.env("TERM_PROGRAM", "ptrterminal");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        cmd.env("MYCMUX_TERM_PROGRAM", "mycmux");

        if let Some(ref extra_env) = env {
            for (k, v) in extra_env {
                cmd.env(k, v);
            }
        }

        if let Some(dir) = cwd {
            if std::path::Path::new(&dir).is_dir() {
                cmd.cwd(dir);
            } else if let Some(home) = dirs::home_dir() {
                cmd.cwd(home);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {e}"))?;

        #[cfg(target_os = "windows")]
        crate::pty::windows_console::suppress_spawn_flash(std::process::id());

        // Drop slave — we only need master
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

        // Create broadcast channel and scrollback for remote clients
        let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
        let scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAP)));
        let broadcast_tx_clone = broadcast_tx.clone();
        let sb_clone = scrollback.clone();
        let (frontend_tx, mut frontend_rx) = mpsc::channel::<Vec<u8>>(FRONTEND_QUEUE_CAP);

        tauri::async_runtime::spawn(async move {
            while let Some(first_chunk) = frontend_rx.recv().await {
                let mut batch = first_chunk;

                while batch.len() < FRONTEND_BATCH_MAX_BYTES {
                    match frontend_rx.try_recv() {
                        Ok(chunk) => batch.extend_from_slice(&chunk),
                        Err(mpsc::error::TryRecvError::Empty) => break,
                        Err(mpsc::error::TryRecvError::Disconnected) => break,
                    }
                }

                // Tauri Channel is unbounded, so this forwarder rate-limits
                // frontend IPC instead of draining the bounded queue instantly.
                let _ = data_channel.send(batch);
                tokio::time::sleep(Duration::from_millis(FRONTEND_FLUSH_INTERVAL_MS)).await;
            }
        });

        // Spawn reader thread — blocking I/O, not tokio
        let sid = session_id.clone();
        let handle = app_handle.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096]; // 4KB — matches OS page size
            let mut osc7 = Osc7Parser::new();
            let mut frontend_open = true;
            loop {
                let read_start = Instant::now();
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let read_micros = read_start.elapsed().as_micros();

                        // OSC 7: side-channel CWD observation. Bytes are NOT stripped —
                        // xterm.js ignores unknown OSCs, so passing them through is safe.
                        if let Some(cwd_raw) = osc7.feed(&buf[..n]) {
                            let cwd = cwd_raw
                                .trim_end_matches(['\n', '\r'])
                                .trim_end_matches('/')
                                .to_string();
                            if !cwd.is_empty() {
                                let prev = metadata_store.get(&sid).map(|m| m.clone());
                                let should_emit = match &prev {
                                    Some(m) => m.cwd != cwd,
                                    None => true,
                                };
                                if should_emit {
                                    let meta = match prev {
                                        Some(old) => PtyMetadata {
                                            session_id: sid.clone(),
                                            cwd: cwd.clone(),
                                            git_branch: old.git_branch.clone(),
                                            process_name: old.process_name.clone(),
                                            claude_session_id: old.claude_session_id.clone(),
                                        },
                                        None => PtyMetadata {
                                            session_id: sid.clone(),
                                            cwd: cwd.clone(),
                                            git_branch: None,
                                            process_name: None,
                                            claude_session_id: None,
                                        },
                                    };
                                    metadata_store.insert(sid.clone(), meta.clone());
                                    let _ = handle.emit("pty_metadata", meta);
                                }
                            }
                        }

                        let send_start = Instant::now();
                        let chunk = buf[..n].to_vec();
                        if frontend_open {
                            match frontend_tx.try_send(chunk.clone()) {
                                Ok(()) => {}
                                Err(mpsc::error::TrySendError::Full(chunk)) => {
                                    thread::sleep(Duration::from_millis(
                                        FRONTEND_FULL_RETRY_DELAY_MS,
                                    ));
                                    match frontend_tx.try_send(chunk) {
                                        Ok(()) => {}
                                        Err(mpsc::error::TrySendError::Full(_)) => {
                                            // Prefer dropping display-only frontend data over
                                            // blocking the PTY reader and stalling the shell.
                                        }
                                        Err(mpsc::error::TrySendError::Closed(_)) => {
                                            frontend_open = false;
                                        }
                                    }
                                }
                                Err(mpsc::error::TrySendError::Closed(_)) => {
                                    frontend_open = false;
                                }
                            }
                        }
                        let send_micros = send_start.elapsed().as_micros();

                        // Also send to broadcast for remote clients
                        let _ = broadcast_tx_clone.send(chunk.clone());
                        // Append to scrollback ring buffer
                        if let Ok(mut sb) = sb_clone.lock() {
                            sb.extend(chunk.iter().copied());
                            let overflow = sb.len().saturating_sub(SCROLLBACK_CAP);
                            if overflow > 0 {
                                drop(sb.drain(..overflow));
                            }
                        }

                        // Log slow reads in debug builds only
                        if cfg!(debug_assertions) && (read_micros > 1000 || send_micros > 1000) {
                            eprintln!(
                                "[PERF] PTY read: {}μs, channel send: {}μs, bytes: {}",
                                read_micros, send_micros, n
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
            let exit_event = events::pty_exit_event(&sid);
            let _ = handle.emit(&exit_event, ());
        });

        Ok(Self {
            child: Mutex::new(child),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            broadcast: broadcast_tx,
            scrollback,
        })
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let start = Instant::now();
        let mut writer = self
            .writer
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;

        let lock_micros = start.elapsed().as_micros();
        let write_start = Instant::now();

        // Chunk writes to avoid PTY buffer overflow (conpty ~4KB limit)
        for chunk in data.chunks(1024) {
            writer
                .write_all(chunk)
                .map_err(|e| format!("Write failed: {e}"))?;
            writer.flush().map_err(|e| format!("Flush failed: {e}"))?;
        }

        let write_micros = write_start.elapsed().as_micros();
        let total_micros = start.elapsed().as_micros();

        // Log slow writes in debug builds only
        if cfg!(debug_assertions) && total_micros > 1000 {
            eprintln!(
                "[PERF] PTY write: lock={}μs, write+flush={}μs, total={}μs, bytes={}",
                lock_micros,
                write_micros,
                total_micros,
                data.len()
            );
        }

        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self
            .master
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {e}"))
    }

    pub fn kill(&self) -> Result<(), String> {
        let mut child = self.child.lock().map_err(|e| format!("Lock failed: {e}"))?;
        child.kill().map_err(|e| format!("Kill failed: {e}"))
    }

    pub fn process_id(&self) -> Option<u32> {
        if let Ok(child) = self.child.lock() {
            child.process_id()
        } else {
            None
        }
    }

    pub fn get_scrollback(&self) -> Vec<u8> {
        self.scrollback
            .lock()
            .map(|sb| sb.iter().copied().collect())
            .unwrap_or_default()
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}
