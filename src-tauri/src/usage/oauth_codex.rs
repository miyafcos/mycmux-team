use crate::usage::WindowStat;
use chrono::{TimeZone, Utc};
use reqwest::header::{ACCEPT, USER_AGENT};
use serde_json::Value;
use std::{env, fs, path::PathBuf};

#[derive(Clone, Debug)]
pub struct CodexUsage {
    pub five_hour: Option<WindowStat>,
    pub seven_day: Option<WindowStat>,
}

impl CodexUsage {
    pub fn has_usage(&self) -> bool {
        self.five_hour.is_some() || self.seven_day.is_some()
    }
}

#[derive(Clone, Debug)]
struct CodexCredentials {
    access_token: String,
    account_id: Option<String>,
}

pub async fn fetch() -> Result<CodexUsage, String> {
    let credentials = load_credentials()?;
    let client = reqwest::Client::new();
    let urls = usage_urls();
    let mut errors = Vec::new();

    for url in urls {
        match fetch_from_url(&client, &credentials, &url).await {
            Ok(usage) => return Ok(usage),
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }

    Err(format!(
        "Codex rate-limit endpoint unavailable: {}",
        errors.join(" | ")
    ))
}

async fn fetch_from_url(
    client: &reqwest::Client,
    credentials: &CodexCredentials,
    url: &str,
) -> Result<CodexUsage, String> {
    let mut request = client
        .get(url)
        .bearer_auth(&credentials.access_token)
        .header(USER_AGENT, "CodexBar")
        .header(ACCEPT, "application/json");

    if let Some(account_id) = credentials.account_id.as_deref().filter(|value| !value.is_empty()) {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("network error: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("response read failed: {error}"))?;

    if !status.is_success() {
        return Err(http_error(status.as_u16(), &body));
    }

    let value: Value =
        serde_json::from_str(&body).map_err(|error| format!("JSON parse failed: {error}"))?;
    parse_usage(&value).ok_or_else(|| "rate-limit windows missing in response".to_string())
}

fn load_credentials() -> Result<CodexCredentials, String> {
    let path = auth_path()?;
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Codex auth.json not readable: {error}"))?;
    let value: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("Codex auth.json parse failed: {error}"))?;
    let tokens = value
        .get("tokens")
        .ok_or_else(|| "Codex auth.json contains no ChatGPT OAuth tokens".to_string())?;
    let access_token = string_field(tokens, &["access_token", "accessToken"])
        .or_else(|| string_field(tokens, &["id_token", "idToken"]))
        .ok_or_else(|| "Codex access token missing. Run `codex` to re-authenticate.".to_string())?;
    let account_id = string_field(tokens, &["account_id", "accountId"]);

    Ok(CodexCredentials {
        access_token,
        account_id,
    })
}

fn auth_path() -> Result<PathBuf, String> {
    let root = env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .ok_or_else(|| "Home directory not found for Codex auth.json".to_string())?;
    Ok(root.join("auth.json"))
}

fn usage_urls() -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(configured_base) = read_chatgpt_base_url() {
        push_unique(&mut urls, resolve_usage_url(&configured_base));
        push_unique(
            &mut urls,
            "https://chatgpt.com/backend-api/wham/usage".to_string(),
        );
    } else {
        push_unique(
            &mut urls,
            "https://chatgpt.com/backend-api/wham/usage".to_string(),
        );
        push_unique(&mut urls, "https://chatgpt.com/api/codex/usage".to_string());
    }
    urls
}

fn read_chatgpt_base_url() -> Option<String> {
    let root = env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))?;
    let contents = fs::read_to_string(root.join("config.toml")).ok()?;
    for line in contents.lines() {
        let trimmed = line.split('#').next().unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim() != "chatgpt_base_url" {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn resolve_usage_url(base_url: &str) -> String {
    let mut normalized = base_url.trim().trim_end_matches('/').to_string();
    if normalized.is_empty() {
        normalized = "https://chatgpt.com/backend-api".to_string();
    }
    if (normalized.starts_with("https://chatgpt.com")
        || normalized.starts_with("https://chat.openai.com"))
        && !normalized.contains("/backend-api")
    {
        normalized.push_str("/backend-api");
    }
    if normalized.contains("/backend-api") {
        format!("{normalized}/wham/usage")
    } else {
        format!("{normalized}/api/codex/usage")
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn parse_usage(value: &Value) -> Option<CodexUsage> {
    let rate_limit = value
        .get("rate_limit")
        .or_else(|| value.get("rateLimit"))
        .or_else(|| value.get("rate_limits"))
        .or_else(|| value.get("rateLimits"))
        .unwrap_or(value);
    let primary = parse_window(rate_limit, &["primary_window", "primaryWindow", "primary"]);
    let secondary = parse_window(
        rate_limit,
        &["secondary_window", "secondaryWindow", "secondary"],
    );
    let (five_hour, seven_day) = normalize_windows(primary, secondary);

    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }

    Some(CodexUsage {
        five_hour,
        seven_day,
    })
}

#[derive(Clone, Debug)]
struct ParsedWindow {
    stat: WindowStat,
    window_seconds: Option<i64>,
}

fn parse_window(root: &Value, keys: &[&str]) -> Option<ParsedWindow> {
    let window = keys.iter().find_map(|key| root.get(*key))?;
    if window.is_null() {
        return None;
    }
    let pct = number_field(
        window,
        &["used_percent", "usedPercent", "utilization", "percent", "pct"],
    )?;
    let resets_at = reset_field(window).unwrap_or_default();
    let window_seconds = number_field(window, &["limit_window_seconds", "limitWindowSeconds"])
        .map(|value| value.round() as i64)
        .or_else(|| {
            number_field(window, &["window_minutes", "windowMinutes"])
                .map(|value| (value * 60.0).round() as i64)
        });

    Some(ParsedWindow {
        stat: WindowStat {
            pct: normalize_pct(pct),
            resets_at,
        },
        window_seconds,
    })
}

fn normalize_windows(
    primary: Option<ParsedWindow>,
    secondary: Option<ParsedWindow>,
) -> (Option<WindowStat>, Option<WindowStat>) {
    match (primary, secondary) {
        (Some(primary), Some(secondary)) => match (role(&primary), role(&secondary)) {
            (WindowRole::Weekly, WindowRole::Session)
            | (WindowRole::Weekly, WindowRole::Unknown) => {
                (Some(secondary.stat), Some(primary.stat))
            }
            _ => (Some(primary.stat), Some(secondary.stat)),
        },
        (Some(primary), None) => match role(&primary) {
            WindowRole::Weekly => (None, Some(primary.stat)),
            WindowRole::Session | WindowRole::Unknown => (Some(primary.stat), None),
        },
        (None, Some(secondary)) => match role(&secondary) {
            WindowRole::Session | WindowRole::Unknown => (Some(secondary.stat), None),
            WindowRole::Weekly => (None, Some(secondary.stat)),
        },
        (None, None) => (None, None),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowRole {
    Session,
    Weekly,
    Unknown,
}

fn role(window: &ParsedWindow) -> WindowRole {
    match window.window_seconds {
        Some(18_000) => WindowRole::Session,
        Some(604_800) => WindowRole::Weekly,
        _ => WindowRole::Unknown,
    }
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
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
    for key in ["reset_at", "resetAt", "resets_at", "resetsAt"] {
        if let Some(raw) = value.get(key) {
            if let Some(number) = number_to_i64(raw) {
                return Some(epoch_to_rfc3339(number));
            }
            if let Some(text) = raw.as_str() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn normalize_pct(value: f64) -> f64 {
    let pct = if value <= 1.0 { value * 100.0 } else { value };
    pct.clamp(0.0, 999.9)
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

fn http_error(status: u16, body: &str) -> String {
    let cleaned = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return format!("HTTP {status}");
    }
    format!("HTTP {status}: {}", truncate(&cleaned, 300))
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect::<String>() + "..."
}
