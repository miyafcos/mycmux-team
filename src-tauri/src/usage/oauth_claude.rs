use super::util::{epoch_to_rfc3339, normalize_pct, number_field, number_to_i64, truncate};
use crate::usage::{NamedWindow, WindowStat};
use chrono::{DateTime, Utc};
use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use serde_json::Value;
use std::{fs, path::PathBuf};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER: &str = "oauth-2025-04-20";
// Keep roughly in sync with the locally installed Claude Code CLI
// (`claude --version`) — the endpoint only requires the claude-code/<v>
// shape, but a wildly stale version is a needless fingerprint mismatch.
pub const CLAUDE_CODE_UA: &str = "claude-code/2.1.207";

#[derive(Clone, Debug)]
pub struct ClaudeUsage {
    pub five_hour: Option<WindowStat>,
    pub seven_day: Option<WindowStat>,
    pub seven_day_sonnet: Option<WindowStat>,
    pub seven_day_opus: Option<WindowStat>,
    /// Windows beyond the four fixed keys — per-model weekly limits and any
    /// future additions. See [`parse_extra_windows`].
    pub model_windows: Vec<NamedWindow>,
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
    fetch_with_token(&reqwest::Client::new(), &access_token).await
}

pub async fn fetch_with_token(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<ClaudeUsage, String> {
    fetch_with_token_status(client, access_token)
        .await
        .map_err(|(_, message)| message)
}

pub async fn fetch_with_token_status(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<ClaudeUsage, (Option<u16>, String)> {
    let response = client
        .get(USAGE_URL)
        .bearer_auth(access_token)
        .header("anthropic-beta", BETA_HEADER)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(USER_AGENT, CLAUDE_CODE_UA)
        .send()
        .await
        .map_err(|error| (None, format!("Claude OAuth network error: {error}")))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| (None, format!("Claude OAuth response read failed: {error}")))?;

    if !status.is_success() {
        return Err((
            Some(status.as_u16()),
            http_error("Claude OAuth", status.as_u16(), &body),
        ));
    }

    let value: Value = serde_json::from_str(&body)
        .map_err(|error| (None, format!("Claude OAuth JSON parse failed: {error}")))?;

    Ok(parse_usage(&value))
}

fn parse_usage(value: &Value) -> ClaudeUsage {
    ClaudeUsage {
        five_hour: parse_window(value, &["five_hour"]),
        seven_day: parse_window(value, &["seven_day"]),
        seven_day_sonnet: parse_window(value, &["seven_day_sonnet"]),
        seven_day_opus: parse_window(value, &["seven_day_opus"]),
        model_windows: parse_extra_windows(value),
    }
}

const KNOWN_WINDOW_KEYS: [&str; 4] = ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"];

/// Every window the response carries beyond the four fixed keys.
///
/// The endpoint has grown windows before (per-model weekly limits) and will
/// again; naming them here would mean a release per model. So this parses by
/// shape instead: any other top-level object with a utilization number is a
/// window, and any entry of a top-level `limits` array that names itself and
/// carries one is too. Objects that don't look like windows are skipped, so a
/// response without extras yields an empty list rather than an error.
fn parse_extra_windows(root: &Value) -> Vec<NamedWindow> {
    let mut extras = Vec::new();
    if let Some(map) = root.as_object() {
        for (key, value) in map {
            if KNOWN_WINDOW_KEYS.contains(&key.as_str()) || !value.is_object() {
                continue;
            }
            if let Some(window) = parse_window(root, &[key.as_str()]) {
                extras.push(NamedWindow {
                    key: key.clone(),
                    window,
                });
            }
        }
    }
    if let Some(limits) = root.get("limits").and_then(Value::as_array) {
        for entry in limits {
            let Some(name) = ["name", "model", "id", "key"]
                .iter()
                .find_map(|key| entry.get(*key).and_then(Value::as_str))
                .filter(|name| !name.trim().is_empty())
            else {
                continue;
            };
            let Some(pct) = number_field(
                entry,
                &["utilization", "used_percent", "usedPercent", "percent", "pct"],
            ) else {
                continue;
            };
            extras.push(NamedWindow {
                key: name.to_string(),
                window: WindowStat {
                    pct: normalize_pct(pct),
                    resets_at: reset_field(entry).unwrap_or_default(),
                },
            });
        }
    }
    extras
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

fn normalize_reset_string(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|_| value.to_string())
}

fn http_error(label: &str, status: u16, body: &str) -> String {
    let cleaned = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return format!("{label} error: HTTP {status}");
    }
    format!("{label} error: HTTP {status}: {}", truncate(&cleaned, 300))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_usage_reads_the_four_fixed_windows() {
        let usage = parse_usage(&json!({
            "five_hour": { "utilization": 12.5, "resets_at": "2026-08-09T16:00:00Z" },
            "seven_day": { "utilization": 58, "resets_at": "2026-08-12T00:00:00Z" },
            "seven_day_sonnet": null,
        }));
        assert_eq!(usage.five_hour.as_ref().map(|stat| stat.pct), Some(12.5));
        assert_eq!(
            usage.five_hour.as_ref().map(|stat| stat.resets_at.as_str()),
            Some("2026-08-09T16:00:00+00:00")
        );
        assert_eq!(usage.seven_day.as_ref().map(|stat| stat.pct), Some(58.0));
        assert!(usage.seven_day_sonnet.is_none());
        assert!(usage.seven_day_opus.is_none());
        assert!(usage.model_windows.is_empty());
    }

    #[test]
    fn extra_windows_are_parsed_by_shape_not_by_name() {
        let usage = parse_usage(&json!({
            "five_hour": { "utilization": 1.5 },
            // An unanticipated per-model window: object with a utilization.
            "seven_day_fable": { "utilization": 33, "resets_at": "2026-08-12T00:00:00Z" },
            // Objects without a utilization number are not windows.
            "account": { "email": "someone@example.com" },
            // Non-objects are skipped outright.
            "plan": "max",
        }));
        assert_eq!(usage.model_windows.len(), 1);
        assert_eq!(usage.model_windows[0].key, "seven_day_fable");
        assert_eq!(usage.model_windows[0].window.pct, 33.0);
        assert_eq!(
            usage.model_windows[0].window.resets_at,
            "2026-08-12T00:00:00+00:00"
        );
        // The fixed four never duplicate into the extras.
        assert_eq!(usage.five_hour.as_ref().map(|stat| stat.pct), Some(1.5));
    }

    #[test]
    fn limits_array_entries_become_named_windows() {
        let usage = parse_usage(&json!({
            "limits": [
                { "name": "fable", "utilization": 0.42, "resets_at": 1770000000 },
                { "model": "opus", "utilization": 7 },
                { "name": "", "utilization": 5 },
                { "name": "no-utilization" },
            ]
        }));
        assert_eq!(usage.model_windows.len(), 2);
        assert_eq!(usage.model_windows[0].key, "fable");
        assert_eq!(usage.model_windows[0].window.pct, 42.0);
        assert!(!usage.model_windows[0].window.resets_at.is_empty());
        assert_eq!(usage.model_windows[1].key, "opus");
        assert_eq!(usage.model_windows[1].window.pct, 7.0);
        assert_eq!(usage.model_windows[1].window.resets_at, "");
    }
}
