pub mod oauth_claude;
pub mod oauth_login;
pub mod oauth_codex;
pub mod token_store;
mod util;

use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const PENDING_LOGIN_TTL_SECS: u64 = 600;
pub const USAGE_CACHE_TTL_MS: i64 = 150_000;

/// Best-effort append-only failure log for OAuth flows
/// (`<app_data>/logs/oauth.log`). Release builds run with
/// `windows_subsystem = "windows"` so stderr goes nowhere — this file is the
/// only persistent evidence of auth failures. Callers must pass error strings
/// built from status codes, diagnostic headers, and error-response bodies
/// only; never token values.
pub fn log_oauth_failure(app: &tauri::AppHandle, context: &str, detail: &str) {
    use tauri::Manager;
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let logs_dir = data_dir.join("logs");
    if std::fs::create_dir_all(&logs_dir).is_err() {
        return;
    }
    let line = format!(
        "{} [{}] {}\n",
        chrono::Utc::now().to_rfc3339(),
        context,
        detail.replace('\n', " ")
    );
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("oauth.log"))
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
}

pub struct UsageOauthState {
    pub http: reqwest::Client,
    pub pending_logins: tokio::sync::Mutex<HashMap<String, PendingLogin>>,
    pub refresh_lock: tokio::sync::Mutex<()>,
    pub cooldowns: tokio::sync::Mutex<HashMap<String, Cooldown>>,
    pub usage_cache: tokio::sync::Mutex<HashMap<String, CachedUsage>>,
}

impl UsageOauthState {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(oauth_claude::CLAUDE_CODE_UA)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            http,
            pending_logins: tokio::sync::Mutex::new(HashMap::new()),
            refresh_lock: tokio::sync::Mutex::new(()),
            cooldowns: tokio::sync::Mutex::new(HashMap::new()),
            usage_cache: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl Default for UsageOauthState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct PendingLogin {
    pub verifier: String,
    pub state: String,
    pub redirect_uri: String,
    pub created_at: Instant,
}

#[derive(Clone, Copy)]
pub struct Cooldown {
    pub until_ms: i64,
    pub backoff_ms: i64,
}

pub struct CachedUsage {
    pub account: AccountUsage,
    pub fetched_at_ms: i64,
}

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

#[derive(Serialize, Clone, Debug)]
pub struct AccountUsage {
    pub account_id: String,
    pub label: String,
    pub enabled: bool,
    pub needs_reauth: bool,
    pub five_hour: Option<WindowStat>,
    pub seven_day: Option<WindowStat>,
    pub seven_day_sonnet: Option<WindowStat>,
    pub seven_day_opus: Option<WindowStat>,
    pub error: Option<String>,
    pub fetched_at: String,
}
