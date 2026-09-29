//! Small cross-cutting helpers shared by several modules.
//!
//! Anything here must stay dependency-free with respect to the rest of the
//! crate (no `AppState`, no Tauri commands) so it can be pulled in from
//! `commands`, `pty`, `db`, and `cli_accounts` alike.

pub mod atomic_write;
pub mod ids;
pub mod process;
pub mod task;
