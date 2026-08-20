pub mod credentials;
pub mod legacy;
pub mod oauth_claude;
pub mod oauth_codex;
pub mod oauth_grok;
pub mod refresh;
mod util;

use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;

/// Slightly under the frontend poll interval (180s), so a scheduled poll
/// always fetches fresh numbers while a focus-triggered poll shortly after
/// one is served from cache instead of flapping between hit and miss.
pub const USAGE_CACHE_TTL_MS: i64 = 150_000;

/// Best-effort append-only failure log for OAuth flows
/// (`<app_data>/logs/oauth.log`). Release builds run with
/// `windows_subsystem = "windows"` so stderr goes nowhere — this file is the
/// only persistent evidence of auth failures. Callers must pass error strings
/// built from status codes, diagnostic headers, and error-response bodies
/// only; never token values.
pub fn log_oauth_failure(app: &tauri::AppHandle, context: &str, detail: &str) {
    use tauri::Manager;
    let Ok(default_dir) = app.path().app_data_dir() else {
        return;
    };
    let data_dir = crate::test_profile::app_data_dir_from(default_dir);
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

pub struct UsageState {
    pub http: reqwest::Client,
    pub refresh_lock: tokio::sync::Mutex<()>,
    pub cooldowns: tokio::sync::Mutex<HashMap<String, Cooldown>>,
    pub profile_usage_cache: tokio::sync::Mutex<HashMap<String, CachedWindows>>,
    /// Rows that ran out of budget last round, served first on the next one so
    /// no account is starved forever by its position in the list.
    pub deferred_priority: tokio::sync::Mutex<Vec<String>>,
}

impl UsageState {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(oauth_claude::CLAUDE_CODE_UA)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            http,
            refresh_lock: tokio::sync::Mutex::new(()),
            cooldowns: tokio::sync::Mutex::new(HashMap::new()),
            profile_usage_cache: tokio::sync::Mutex::new(HashMap::new()),
            deferred_priority: tokio::sync::Mutex::new(Vec::new()),
        }
    }

    pub async fn clear_profile(&self, profile_id: &str) {
        self.profile_usage_cache.lock().await.remove(profile_id);
        self.cooldowns
            .lock()
            .await
            .remove(&format!("profile:{profile_id}"));
        self.deferred_priority
            .lock()
            .await
            .retain(|id| id != profile_id);
    }
}

impl Default for UsageState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy)]
pub struct Cooldown {
    pub until_ms: i64,
    pub backoff_ms: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WindowStat {
    pub pct: f64,
    pub resets_at: String,
}

/// A usage window the API named but this code did not anticipate — per-model
/// limits and whatever the provider adds next. Parsed structurally (any object
/// with a utilization number) so new windows appear without a release.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NamedWindow {
    pub key: String,
    pub window: WindowStat,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageRowState {
    Ok,
    WaitForCli,
    Cooldown,
    NeedsRelogin,
    Unsupported,
    Error,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProfileUsage {
    pub profile_id: String,
    pub provider: crate::cli_accounts::CliProvider,
    pub label: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub registered: bool,
    pub is_active: bool,
    pub needs_relogin: bool,
    pub state: UsageRowState,
    pub five_hour: Option<WindowStat>,
    pub seven_day: Option<WindowStat>,
    pub seven_day_sonnet: Option<WindowStat>,
    pub seven_day_opus: Option<WindowStat>,
    pub model_windows: Vec<NamedWindow>,
    pub error_code: Option<String>,
    pub retry_at: Option<String>,
    pub fetched_at: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct AccountUsageReport {
    pub accounts: Vec<ProfileUsage>,
    pub generated_at: String,
}

#[derive(Clone)]
pub struct CachedWindows {
    pub five_hour: Option<WindowStat>,
    pub seven_day: Option<WindowStat>,
    pub seven_day_sonnet: Option<WindowStat>,
    pub seven_day_opus: Option<WindowStat>,
    pub model_windows: Vec<NamedWindow>,
    pub fetched_at_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_row_state_serializes_snake_case() {
        for (state, expected) in [
            (UsageRowState::Ok, "\"ok\""),
            (UsageRowState::WaitForCli, "\"wait_for_cli\""),
            (UsageRowState::Cooldown, "\"cooldown\""),
            (UsageRowState::NeedsRelogin, "\"needs_relogin\""),
            (UsageRowState::Unsupported, "\"unsupported\""),
            (UsageRowState::Error, "\"error\""),
        ] {
            assert_eq!(serde_json::to_string(&state).unwrap(), expected);
        }
    }

    #[test]
    fn profile_usage_wire_contains_no_token_material() {
        let synthetic_access = "synthetic-access";
        let synthetic_refresh = "synthetic-refresh";
        let usage = ProfileUsage {
            profile_id: "profile".into(),
            provider: crate::cli_accounts::CliProvider::Claude,
            label: "label".into(),
            email: None,
            plan: None,
            registered: true,
            is_active: false,
            needs_relogin: false,
            state: UsageRowState::Ok,
            five_hour: None,
            seven_day: None,
            seven_day_sonnet: None,
            seven_day_opus: None,
            model_windows: Vec::new(),
            error_code: None,
            retry_at: None,
            fetched_at: "now".into(),
        };
        let wire = serde_json::to_string(&usage).unwrap();
        assert!(!wire.contains(synthetic_access));
        assert!(!wire.contains(synthetic_refresh));
        let refreshed = crate::usage::refresh::RefreshedClaude {
            access_token: synthetic_access.into(),
            refresh_token: Some(synthetic_refresh.into()),
            expires_at_ms: 1,
            refresh_expires_at_ms: None,
        };
        let codex = crate::usage::refresh::RefreshedCodex {
            access_token: synthetic_access.into(),
            refresh_token: Some(synthetic_refresh.into()),
            id_token: None,
        };
        let grok = crate::usage::credentials::GrokTokens {
            access_token: synthetic_access.into(),
            refresh_token: synthetic_refresh.into(),
            client_id: "synthetic-client".into(),
        };
        let grok_refreshed = crate::usage::refresh::RefreshedGrok {
            access_token: synthetic_access.into(),
            refresh_token: Some(synthetic_refresh.into()),
        };
        let debug = format!("{refreshed:?} {codex:?} {grok:?} {grok_refreshed:?}");
        assert!(!debug.contains(synthetic_access));
        assert!(!debug.contains(synthetic_refresh));
    }
}
