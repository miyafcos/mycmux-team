pub mod commands;
pub mod environment;
pub mod sensors;
pub mod session_log;
pub mod signal;
pub mod work_context;

mod codex;

#[allow(unused_imports)]
pub use commands::{list_codex_pets, save_buddy_settings};

use std::sync::atomic::AtomicBool;
use tauri::{AppHandle, Runtime};

pub static BUDDY_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn init<R: Runtime + 'static>(app: &AppHandle<R>) {
    #[cfg(debug_assertions)]
    {
        eprintln!("[buddy] initializing sensors");
    }
    sensors::spawn_all(app.clone());
}
