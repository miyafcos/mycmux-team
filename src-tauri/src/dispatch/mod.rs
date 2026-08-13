pub mod ledger;
pub mod watchdog;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchEntry {
    pub slug: String,
    pub label: Option<String>,
    pub dir: Option<String>,
    pub cwd: Option<String>,
    pub tab_session_id: Option<String>,
    pub tab_id: Option<String>,
    pub target: Option<String>,
    pub status: Option<String>,
    pub verify: Option<String>,
    pub workstream: Option<String>,
    pub stage: Option<String>,
    pub ts: Option<String>,
    pub has_done: bool,
    pub has_ask: bool,
    pub has_verdict: bool,
    pub done_mtime_ms: Option<u64>,
    pub ask_mtime_ms: Option<u64>,
    pub verdict_mtime_ms: Option<u64>,
    pub dir_mtime_ms: Option<u64>,
    pub session_log_name: Option<String>,
    pub session_log_age_minutes: f64,
    pub live_state: String,
}
