use crate::usage::WindowStat;
use chrono::{DateTime, TimeZone, Utc};
use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use serde_json::Value;
use std::{fs, path::PathBuf};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER: &str = "oauth-2025-04-20";

#[derive(Clone, Debug)]
pub struct ClaudeUsage {
    pub five_hour: Option<WindowStat>,
    pub seven_day: Option<WindowStat>,
    pub seven_day_sonnet: Option<WindowStat>,
    pub seven_day_opus: Option<WindowStat>,
}

impl ClaudeUsage {
    pub fn has_usage(&self) -> bool {
        self.five_hour.is_some()
            || self.seven_day.is_some()
            || self.seven_day_sonnet.is_some()
            || self.seven_day_opus.is_some()
    }
}

pub async fn fetch() -> Result<ClaudeUsage, String> {
    let access_token = load_access_token()?;
    let response = reqwest::Client::new()
        .get(USAGE_URL)
        .bearer_auth(access_token)
        .header("anthropic-beta", BETA_HEADER)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(USER_AGENT, "claude-code/2.1.0")
        .send()
        .await
        .map_err(|error| format!("Claude OAuth network error: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Claude OAuth response read failed: {error}"))?;

    if !status.is_success() {
        return Err(http_error("Claude OAuth", status.as_u16(), &body));
    }

    let value: Value =
        serde_json::from_str(&body).map_err(|error| format!("Claude OAuth JSON parse failed: {error}"))?;

    Ok(ClaudeUsage {
        five_hour: parse_window(&value, &["five_hour"]),
        seven_day: parse_window(&value, &["seven_day"]),
        seven_day_sonnet: parse_window(&value, &["seven_day_sonnet"]),
        seven_day_opus: parse_window(&value, &["seven_day_opus"]),
    })
}

fn load_access_token() -> Result<String, String> {
    let path = credentials_path()?;
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Claude OAuth credentials not readable: {error}"))?;
    let value: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("Claude OAuth credentials JSON parse failed: {error}"))?;
    let oauth = value
        .get("claudeAiOauth")
        .ok_or_else(|| "Claude OAuth credentials missing claudeAiOauth".to_string())?;
    let token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Claude OAuth access token missing. Run `claude` to re-authenticate.".to_string())?;
    let expires_at = oauth
        .get("expiresAt")
        .and_then(number_to_i64)
        .ok_or_else(|| "Claude OAuth expiry missing. Run `claude` to re-authenticate.".to_string())?;
    let expires_at_ms = if expires_at < 10_000_000_000 {
        expires_at.saturating_mul(1000)
    } else {
        expires_at
    };

    if expires_at_ms <= Utc::now().timestamp_millis() {
        return Err("Claude OAuth token expired. Run `claude` to re-authenticate.".to_string());
    }

    Ok(token.to_string())
}

fn credentials_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".claude").join(".credentials.json"))
        .ok_or_else(|| "Home directory not found for Claude OAuth credentials".to_string())
}

fn parse_window(root: &Value, keys: &[&str]) -> Option<WindowStat> {
    let window = keys.iter().find_map(|key| root.get(*key))?;
    if window.is_null() {
        return None;
    }
    let pct = number_field(
        window,
        &["utilization", "used_percent", "usedPercent", "percent", "pct"],
    )?;
    Some(WindowStat {
        pct: normalize_pct(pct),
        resets_at: reset_field(window).unwrap_or_default(),
    })
}

fn number_field(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        let raw = value.get(*key)?;
        raw.as_f64()
            .or_else(|| raw.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

fn reset_field(value: &Value) -> Option<String> {
    for key in ["resets_at", "reset_at", "resetsAt", "resetAt"] {
        if let Some(raw) = value.get(key) {
            if let Some(text) = raw.as_str() {
                return Some(normalize_reset_string(text));
            }
            if let Some(number) = number_to_i64(raw) {
                return Some(epoch_to_rfc3339(number));
            }
        }
    }
    None
}

fn normalize_pct(value: f64) -> f64 {
    let pct = if value <= 1.0 { value * 100.0 } else { value };
    pct.clamp(0.0, 999.9)
}

fn normalize_reset_string(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|_| value.to_string())
}

fn epoch_to_rfc3339(value: i64) -> String {
    let seconds = if value > 10_000_000_000 {
        value / 1000
    } else {
        value
    };
    Utc.timestamp_opt(seconds, 0)
        .single()
        .map(|date| date.to_rfc3339())
        .unwrap_or_default()
}

fn number_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
}

fn http_error(label: &str, status: u16, body: &str) -> String {
    let cleaned = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return format!("{label} error: HTTP {status}");
    }
    format!("{label} error: HTTP {status}: {}", truncate(&cleaned, 300))
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect::<String>() + "..."
}
