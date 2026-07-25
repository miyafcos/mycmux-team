use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::{Client, StatusCode, Url};
use sha2::{Digest, Sha256};

use super::util::truncate;
use crate::usage::token_store::{self, StoredTokens};

pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
pub const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const OAUTH_SCOPE: &str = "user:profile";
// Same beta header the official Claude Code client sends on token requests.
pub const OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
// The token endpoint hard-429s any User-Agent starting with "claude-code/"
// (measured 2026-07-12: claude-code UA -> 429 rate_limit_error on every
// attempt; mycmux/no/other UAs reach grant validation). The shared
// UsageOauthState client defaults to CLAUDE_CODE_UA for the usage endpoint,
// so token requests must override it with an honest client identity.
pub const OAUTH_UA: &str = concat!("mycmux/", env!("CARGO_PKG_VERSION"));
pub const REDIRECT_URI_CANDIDATES: [&str; 2] = [
    "https://platform.claude.com/oauth/code/callback",
    "https://console.anthropic.com/oauth/code/callback",
];
pub const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

pub fn generate_pkce() -> PkcePair {
    let mut verifier_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut verifier_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);

    let mut state_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut state_bytes);
    let state = URL_SAFE_NO_PAD.encode(state_bytes);

    PkcePair {
        challenge: challenge_for(&verifier),
        verifier,
        state,
    }
}

fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn build_authorize_url(pkce: &PkcePair, redirect_uri: &str) -> Result<String, String> {
    Url::parse_with_params(
        AUTHORIZE_URL,
        &[
            ("code", "true"),
            ("client_id", CLIENT_ID),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri),
            ("scope", OAUTH_SCOPE),
            ("code_challenge", pkce.challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", pkce.state.as_str()),
        ],
    )
    .map(|url| url.to_string())
    .map_err(|error| format!("Claude OAuth authorize URL build failed: {error}"))
}

pub fn parse_pasted_code(input: &str) -> Result<(String, String), String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("OAuth code input is empty".to_string());
    }

    let (code, state) = trimmed
        .split_once('#')
        .ok_or_else(|| "OAuth code input must contain '#'".to_string())?;
    let code = code.trim();
    let state = state.trim();
    if code.is_empty() {
        return Err("OAuth code is empty".to_string());
    }
    if state.is_empty() {
        return Err("OAuth state is empty".to_string());
    }

    Ok((code.to_string(), state.to_string()))
}

#[derive(Clone, serde::Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    pub expires_in: i64,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub account: Option<TokenAccount>,
    #[serde(default)]
    pub organization: Option<TokenOrganization>,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct TokenAccount {
    #[serde(default)]
    pub uuid: Option<String>,
    #[serde(default)]
    pub email_address: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct TokenOrganization {
    #[serde(default)]
    pub uuid: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

pub async fn exchange_code(
    client: &Client,
    code: &str,
    state: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let response = client
        .post(TOKEN_URL)
        .header("anthropic-beta", OAUTH_BETA_HEADER)
        .header(reqwest::header::USER_AGENT, OAUTH_UA)
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
            "state": state,
        }))
        .send()
        .await
        .map_err(|error| format!("Claude OAuth token exchange network error: {error}"))?;

    let status = response.status();
    let diag = diag_suffix(response.headers());
    let body = response
        .text()
        .await
        .map_err(|error| format!("Claude OAuth token exchange response read failed: {error}"))?;

    if !status.is_success() {
        return Err(http_error(
            "Claude OAuth token exchange",
            status.as_u16(),
            &body,
            &diag,
        ));
    }

    serde_json::from_str(&body)
        .map_err(|error| format!("Claude OAuth token exchange JSON parse failed: {error}"))
}

/// Returns (status, body, diag) where diag carries Cloudflare/ratelimit
/// response headers (cf-ray, retry-after) for failure diagnostics.
pub async fn refresh_raw(
    client: &Client,
    refresh_token: &str,
) -> Result<(StatusCode, String, String), String> {
    let response = client
        .post(TOKEN_URL)
        .header("anthropic-beta", OAUTH_BETA_HEADER)
        .header(reqwest::header::USER_AGENT, OAUTH_UA)
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }))
        .send()
        .await
        .map_err(|error| format!("Claude OAuth refresh network error: {error}"))?;

    let status = response.status();
    let diag = diag_suffix(response.headers());
    let body = response
        .text()
        .await
        .map_err(|error| format!("Claude OAuth refresh response read failed: {error}"))?;
    Ok((status, body, diag))
}

pub async fn refresh_access_token(
    client: &Client,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let (status, body, diag) = refresh_raw(client, refresh_token).await?;
    if !status.is_success() {
        return Err(http_error(
            "Claude OAuth refresh",
            status.as_u16(),
            &body,
            &diag,
        ));
    }

    serde_json::from_str(&body)
        .map_err(|error| format!("Claude OAuth refresh JSON parse failed: {error}"))
}

pub fn expires_at_ms_from(expires_in_secs: i64, now_ms: i64) -> i64 {
    now_ms.saturating_add(expires_in_secs.saturating_mul(1000))
}

pub fn needs_refresh(expires_at_ms: i64, now_ms: i64) -> bool {
    expires_at_ms.saturating_sub(now_ms) < REFRESH_MARGIN_MS
}

pub async fn ensure_fresh_token(
    app: &tauri::AppHandle,
    state: &crate::usage::UsageOauthState,
    account_id: &str,
) -> Result<String, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let tokens = match token_store::load_tokens(account_id)? {
        Some(tokens) => tokens,
        None => {
            token_store::set_needs_reauth(app, account_id, true)?;
            return Err("Claude usage account requires re-authentication".to_string());
        }
    };
    if !needs_refresh(tokens.expires_at_ms, now_ms) {
        return Ok(tokens.access_token);
    }

    let _refresh_guard = state.refresh_lock.lock().await;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let tokens = match token_store::load_tokens(account_id)? {
        Some(tokens) => tokens,
        None => {
            token_store::set_needs_reauth(app, account_id, true)?;
            return Err("Claude usage account requires re-authentication".to_string());
        }
    };
    if !needs_refresh(tokens.expires_at_ms, now_ms) {
        return Ok(tokens.access_token);
    }

    let (status, body, diag) = refresh_raw(&state.http, &tokens.refresh_token).await?;
    if status.is_success() {
        let refreshed: TokenResponse = serde_json::from_str(&body)
            .map_err(|error| format!("Claude OAuth refresh JSON parse failed: {error}"))?;
        let stored = StoredTokens {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token.unwrap_or(tokens.refresh_token),
            expires_at_ms: expires_at_ms_from(refreshed.expires_in, now_ms),
            scope: refreshed.scope.or(tokens.scope),
        };

        token_store::store_tokens(account_id, &stored)?;
        token_store::set_needs_reauth(app, account_id, false)?;
        return Ok(stored.access_token);
    }

    let refresh_error = match status.as_u16() {
        400 | 401 => {
            token_store::set_needs_reauth(app, account_id, true)?;
            format!("Claude OAuth refresh rejected: HTTP {}{diag}", status.as_u16())
        }
        429 => {
            crate::commands::usage::apply_429_cooldown(state, account_id, now_ms).await;
            format!("Claude OAuth refresh rate limited: HTTP 429{diag}")
        }
        code => format!("Claude OAuth refresh failed: HTTP {code}{diag}"),
    };
    crate::usage::log_oauth_failure(app, "refresh", &refresh_error);
    Err(refresh_error)
}

/// Compact "[cf-ray: ..., retry-after: ...]" suffix from response headers.
/// Empty when neither header is present. These are the only two headers that
/// help distinguish Cloudflare bot-management blocks from plain rate limits.
fn diag_suffix(headers: &reqwest::header::HeaderMap) -> String {
    let mut parts = Vec::new();
    for name in ["cf-ray", "retry-after"] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            parts.push(format!("{name}: {value}"));
        }
    }
    if parts.is_empty() {
        return String::new();
    }
    format!(" [{}]", parts.join(", "))
}

fn http_error(label: &str, status: u16, body: &str, diag: &str) -> String {
    let cleaned = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return format!("{label} error: HTTP {status}{diag}");
    }
    format!(
        "{label} error: HTTP {status}{diag}: {}",
        truncate(&cleaned, 300)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn rfc7636_challenge_vector() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generated_pkce_has_expected_shape() {
        let pkce = generate_pkce();

        assert_eq!(pkce.verifier.len(), 43);
        assert!(!pkce.verifier.contains(['+', '/', '=']));
        assert_eq!(pkce.challenge, challenge_for(&pkce.verifier));
        assert_ne!(pkce.state, pkce.verifier);
    }

    #[test]
    fn authorize_url_has_exact_query_pairs() {
        let pkce = PkcePair {
            verifier: "verifier".to_string(),
            challenge: "challenge".to_string(),
            state: "state".to_string(),
        };
        let redirect_uri = REDIRECT_URI_CANDIDATES[0];
        let url = Url::parse(&build_authorize_url(&pkce, redirect_uri).unwrap()).unwrap();
        let pairs = url.query_pairs().into_owned().collect::<Vec<_>>();
        let values = pairs.iter().cloned().collect::<HashMap<_, _>>();

        assert_eq!(pairs.len(), 8);
        assert_eq!(values.len(), 8);
        assert_eq!(values.get("code").map(String::as_str), Some("true"));
        assert_eq!(values.get("client_id").map(String::as_str), Some(CLIENT_ID));
        assert_eq!(
            values.get("response_type").map(String::as_str),
            Some("code")
        );
        assert_eq!(
            values.get("redirect_uri").map(String::as_str),
            Some(redirect_uri)
        );
        assert_eq!(values.get("scope").map(String::as_str), Some(OAUTH_SCOPE));
        assert_eq!(
            values.get("code_challenge").map(String::as_str),
            Some("challenge")
        );
        assert_eq!(
            values.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(values.get("state").map(String::as_str), Some("state"));
    }

    #[test]
    fn pasted_code_parsing() {
        assert_eq!(
            parse_pasted_code("code#state").unwrap(),
            ("code".to_string(), "state".to_string())
        );
        assert_eq!(
            parse_pasted_code("  code  #  state  ").unwrap(),
            ("code".to_string(), "state".to_string())
        );
        assert_eq!(
            parse_pasted_code("code#state#tail").unwrap(),
            ("code".to_string(), "state#tail".to_string())
        );
        assert_eq!(
            parse_pasted_code("code").unwrap_err(),
            "OAuth code input must contain '#'"
        );
        assert_eq!(
            parse_pasted_code("#state").unwrap_err(),
            "OAuth code is empty"
        );
        assert_eq!(
            parse_pasted_code("code#").unwrap_err(),
            "OAuth state is empty"
        );
        assert_eq!(
            parse_pasted_code("  ").unwrap_err(),
            "OAuth code input is empty"
        );
    }

    #[test]
    fn expiry_calculation_and_refresh_boundary() {
        assert_eq!(expires_at_ms_from(3600, 1_000), 3_601_000);

        let now_ms = 10_000;
        assert!(needs_refresh(now_ms + REFRESH_MARGIN_MS - 1, now_ms));
        assert!(!needs_refresh(now_ms + REFRESH_MARGIN_MS, now_ms));
        assert!(!needs_refresh(now_ms + REFRESH_MARGIN_MS + 1, now_ms));
    }
}
