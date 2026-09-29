//! WorkOrder domain authority.
//!
//! This module deliberately contains no Tauri commands or execution code. It
//! owns only the typed plan, its persistence, and machine-verifiable completion
//! rules. Dispatching the persisted outbox is a later phase.

mod advance;
mod context;
mod done;
mod executor;
mod model;
mod schema;
mod store;
mod worktree;

pub use advance::*;
pub use context::*;
pub use done::*;
pub use executor::*;
pub use model::*;
pub use store::*;
pub use worktree::*;

#[cfg(test)]
mod tests;
