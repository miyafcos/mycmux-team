use reqwest::{Client, StatusCode};
use serde::Deserialize;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};

use super::util::{redacted, truncate};

pub const CLAUDE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const REFRESH_UA: &str = concat!("mycmux/", env!("CARGO_PKG_VERSION"));
pub const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const GROK_TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";

static CODEX_REFRESH_DISABLED: AtomicBool = AtomicBool::new(false);

/// Carries the status and the provider's own error code, because "the refresh
/// was refused" is not a diagnosis: a stale snapshot token, a token the CLI
/// already rotated, and a wrong client id all land here and are told apart only
/// by what the endpoint said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefreshError {
    Rejected {
        status: Option<u16>,
        code: Option<String>,
    },
    Unsupported {
        status: Option<u16>,
        code: Option<String>,
    },
    RateLimited {
        retry_after_secs: Option<u64>,
    },
    Transient(u16),
    Network,
}

pub struct RefreshedClaude {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at_ms: i64,
    pub refresh_expires_at_ms: Option<i64>,
}

pub struct RefreshedCodex {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
}

pub struct RefreshedGrok {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

impl fmt::Debug for RefreshedClaude {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RefreshedClaude")
            .field("access_token", &redacted(&self.access_token))
            .field(
                "refresh_token",
                &self.refresh_token.as_deref().map(redacted),
            )
            .field("expires_at_ms", &self.expires_at_ms)
            .field("refresh_expires_at_ms", &self.refresh_expires_at_ms)
            .finish()
    }
}

impl fmt::Debug for RefreshedCodex {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RefreshedCodex")
            .field("access_token", &redacted(&self.access_token))
            .field(
                "refresh_token",
                &self.refresh_token.as_deref().map(redacted),
            )
            .field("id_token", &self.id_token.as_deref().map(redacted))
            .finish()
    }
}

impl fmt::Debug for RefreshedGrok {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RefreshedGrok")
            .field("access_token", &redacted(&self.access_token))
            .field("refresh_token", &self.refresh_token.as_deref().map(redacted))
            .finish()
    }
}

#[derive(Deserialize)]
struct ClaudeRefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
    #[serde(default, alias = "refresh_token_expires_in")]
    refresh_expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct CodexRefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct GrokRefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

pub fn codex_refresh_disabled() -> bool {
    CODEX_REFRESH_DISABLED.load(Ordering::Relaxed)
}

pub fn disable_codex_refresh() {
    CODEX_REFRESH_DISABLED.store(true, Ordering::Relaxed);
}

pub fn classify_refresh_error(status: Option<u16>, body_error: Option<&str>) -> RefreshError {
    let code = body_error.map(str::to_string);
    match (status, body_error) {
        (_, Some("invalid_client" | "unauthorized_client")) | (Some(404 | 405), _) => {
            RefreshError::Unsupported { status, code }
        }
        (_, Some("invalid_grant")) | (Some(400 | 401), _) => RefreshError::Rejected { status, code },
        (Some(429), _) => RefreshError::RateLimited {
            retry_after_secs: None,
        },
        (Some(code), _) => RefreshError::Transient(code),
        (None, _) => RefreshError::Network,
    }
}

pub async fn refresh_claude(
    client: &Client,
    refresh_token: &str,
) -> Result<RefreshedClaude, RefreshError> {
    let (status, body, retry_after) = post_refresh(
        client,
        CLAUDE_TOKEN_URL,
        serde_json::json!({"grant_type":"refresh_token","refresh_token":refresh_token,"client_id":CLAUDE_CLIENT_ID}),
        true,
    ).await?;
    if !status.is_success() {
        return Err(classify_with_retry(status, &body, retry_after));
    }
    let response: ClaudeRefreshResponse =
        serde_json::from_str(&body).map_err(|_| RefreshError::Transient(status.as_u16()))?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    Ok(RefreshedClaude {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        expires_at_ms: now_ms.saturating_add(response.expires_in.saturating_mul(1000)),
        refresh_expires_at_ms: response
            .refresh_expires_in
            .map(|value| now_ms.saturating_add(value.saturating_mul(1000))),
    })
}

pub async fn refresh_codex(
    client: &Client,
    refresh_token: &str,
) -> Result<RefreshedCodex, RefreshError> {
    let (status, body, retry_after) = post_refresh(
        client,
        CODEX_TOKEN_URL,
        serde_json::json!({"grant_type":"refresh_token","refresh_token":refresh_token,"client_id":CODEX_CLIENT_ID,"scope":"openid profile email"}),
        false,
    ).await?;
    if !status.is_success() {
        let error = classify_with_retry(status, &body, retry_after);
        if matches!(error, RefreshError::Unsupported { .. }) {
            disable_codex_refresh();
        }
        return Err(error);
    }
    let response: CodexRefreshResponse =
        serde_json::from_str(&body).map_err(|_| RefreshError::Transient(status.as_u16()))?;
    Ok(RefreshedCodex {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        id_token: response.id_token,
    })
}

pub async fn refresh_grok(
    client: &Client,
    refresh_token: &str,
    client_id: &str,
) -> Result<RefreshedGrok, RefreshError> {
    let (status, body, retry_after) = post_refresh(
        client,
        GROK_TOKEN_URL,
        serde_json::json!({"grant_type":"refresh_token","refresh_token":refresh_token,"client_id":client_id}),
        false,
    ).await?;
    if !status.is_success() {
        return Err(classify_with_retry(status, &body, retry_after));
    }
    let response: GrokRefreshResponse =
        serde_json::from_str(&body).map_err(|_| RefreshError::Transient(status.as_u16()))?;
    Ok(RefreshedGrok {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
    })
}

async fn post_refresh(
    client: &Client,
    url: &str,
    body: serde_json::Value,
    claude: bool,
) -> Result<(StatusCode, String, Option<u64>), RefreshError> {
    let mut request = client
        .post(url)
        .header(reqwest::header::USER_AGENT, REFRESH_UA)
        .json(&body);
    if claude {
        request = request.header("anthropic-beta", "oauth-2025-04-20");
    }
    let response = request.send().await.map_err(|_| RefreshError::Network)?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    let diag = diag_suffix(response.headers());
    let body = response.text().await.map_err(|_| RefreshError::Network)?;
    if !status.is_success() {
        eprintln!(
            "OAuth refresh failure: HTTP {}{}: {}",
            status.as_u16(),
            diag,
            truncate(&body.split_whitespace().collect::<Vec<_>>().join(" "), 300)
        );
    }
    Ok((status, body, retry_after))
}

fn classify_with_retry(
    status: StatusCode,
    body: &str,
    retry_after_secs: Option<u64>,
) -> RefreshError {
    let body_error = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.as_str())
                .map(str::to_string)
        });
    match classify_refresh_error(Some(status.as_u16()), body_error.as_deref()) {
        RefreshError::RateLimited { .. } => RefreshError::RateLimited { retry_after_secs },
        error => error,
    }
}

fn diag_suffix(headers: &reqwest::header::HeaderMap) -> String {
    let parts = ["cf-ray", "retry-after"]
        .iter()
        .filter_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(|value| format!("{name}: {value}"))
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        String::new()
    } else {
        format!(" [{}]", parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_error_classification() {
        for (status, error, expected) in [
            (
                Some(400),
                Some("invalid_grant"),
                RefreshError::Rejected {
                    status: Some(400),
                    code: Some("invalid_grant".into()),
                },
            ),
            (
                Some(401),
                None,
                RefreshError::Rejected {
                    status: Some(401),
                    code: None,
                },
            ),
            (
                Some(400),
                Some("invalid_client"),
                RefreshError::Unsupported {
                    status: Some(400),
                    code: Some("invalid_client".into()),
                },
            ),
            (
                Some(404),
                None,
                RefreshError::Unsupported {
                    status: Some(404),
                    code: None,
                },
            ),
            (
                Some(405),
                None,
                RefreshError::Unsupported {
                    status: Some(405),
                    code: None,
                },
            ),
            (
                Some(429),
                None,
                RefreshError::RateLimited {
                    retry_after_secs: None,
                },
            ),
            (Some(500), None, RefreshError::Transient(500)),
        ] {
            assert_eq!(classify_refresh_error(status, error), expected);
        }
    }

    #[test]
    fn codex_unsupported_disables_provider_not_account() {
        CODEX_REFRESH_DISABLED.store(false, Ordering::SeqCst);
        assert!(!codex_refresh_disabled());
        assert!(matches!(
            classify_refresh_error(Some(401), None),
            RefreshError::Rejected { .. }
        ));
        assert!(!codex_refresh_disabled());
        disable_codex_refresh();
        assert!(codex_refresh_disabled());
    }
}
