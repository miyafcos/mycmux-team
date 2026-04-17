pub mod commands;
pub mod environment;
pub mod sensors;
pub mod session_log;
pub mod signal;

mod codex;

use std::sync::atomic::AtomicBool;
use tauri::{AppHandle, Runtime};

pub static BUDDY_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn init<R: Runtime + 'static>(app: &AppHandle<R>) {
    eprintln!("[buddy] initializing sensors");
    sensors::spawn_all(app.clone());
}
