pub mod oauth_claude;
pub mod oauth_codex;

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct WindowStat {
    pub pct: f64,
    pub resets_at: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct UsageSummary {
    pub claude_5h: Option<WindowStat>,
    pub claude_7d: Option<WindowStat>,
    pub claude_7d_sonnet: Option<WindowStat>,
    pub claude_7d_opus: Option<WindowStat>,
    pub codex_5h: Option<WindowStat>,
    pub codex_7d: Option<WindowStat>,
    pub claude_available: bool,
    pub codex_available: bool,
    pub claude_error: Option<String>,
    pub codex_error: Option<String>,
    pub generated_at: String,
}
