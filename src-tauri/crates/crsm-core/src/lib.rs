pub mod cache;
pub mod handoff;
pub mod matcher;
pub mod models;
pub mod path_norm;
pub mod preview;
pub mod sessions;
pub mod worksets;

pub use handoff::{create_handoff_file, HandoffRequest, HandoffResult};
pub use matcher::rank_sessions;
pub use models::{
    AgentKind, OpenMode, RestorePlan, SessionEntry, Workset, WorksetEntry, WorksetLayout,
};
pub use sessions::{list_all_sessions, ListOptions};
