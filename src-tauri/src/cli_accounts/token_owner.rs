//! Claude's name and tokens live in separate files, written by different processes.
//! A CLI started as X can overwrite the tokens while the name still says P.
//! Trust the profile endpoint, never the name alone; retain only hashed cache keys.

use std::{collections::HashMap, sync::{Mutex, OnceLock}, time::{Duration, Instant}};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenOwner {
    pub account_uuid: String,
    pub email: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OwnerCheck {
    Owner(TokenOwner),
    Rejected { status: u16 },
    RateLimited { retry_after_secs: Option<u64> },
    Unavailable,
}

pub type OwnerLookup<'a> = &'a dyn Fn(&str) -> Option<TokenOwner>;
pub const CLAUDE_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";

pub fn token_key(access_token: &str) -> String {
    hex::encode(Sha256::digest(access_token.as_bytes()))
}

fn owners() -> &'static Mutex<HashMap<String, TokenOwner>> {
    static OWNERS: OnceLock<Mutex<HashMap<String, TokenOwner>>> = OnceLock::new();
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cached_owner(access_token: &str) -> Option<TokenOwner> {
    owners().lock().unwrap_or_else(|error| error.into_inner())
        .get(&token_key(access_token)).cloned()
}

pub fn remember_owner(access_token: &str, owner: &TokenOwner) {
    let mut cache = owners().lock().unwrap_or_else(|error| error.into_inner());
    // ponytail: cap at 256 entries; use LRU eviction if rotation churn makes clearing costly.
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(token_key(access_token), owner.clone());
}

pub fn parse_profile_body(body: &str) -> Option<TokenOwner> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let account = value.get("account")?;
    let uuid = account.get("uuid")?.as_str().filter(|uuid| !uuid.trim().is_empty())?;
    Some(TokenOwner {
        account_uuid: uuid.to_string(),
        email: account.get("email").and_then(serde_json::Value::as_str).map(str::to_string),
    })
}

pub fn classify_profile_response(status: u16, retry_after_secs: Option<u64>, body: &str) -> OwnerCheck {
    match status {
        200..=299 => parse_profile_body(body).map(OwnerCheck::Owner).unwrap_or(OwnerCheck::Unavailable),
        401 | 403 => OwnerCheck::Rejected { status },
        429 => OwnerCheck::RateLimited { retry_after_secs },
        _ => OwnerCheck::Unavailable,
    }
}

pub async fn fetch_claude_token_owner(client: &reqwest::Client, access_token: &str) -> OwnerCheck {
    let Ok(response) = client.get(CLAUDE_PROFILE_URL)
        .bearer_auth(access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, crate::usage::oauth_claude::CLAUDE_CODE_UA)
        .send().await else {
            return OwnerCheck::Unavailable;
        };
    let status = response.status().as_u16();
    let retry_after_secs = response.headers().get("retry-after")
        .and_then(|value| value.to_str().ok()).and_then(|value| value.parse().ok());
    let Ok(body) = response.text().await else {
        return OwnerCheck::Unavailable;
    };
    classify_profile_response(status, retry_after_secs, &body)
}

pub async fn claude_token_owner(client: &reqwest::Client, access_token: &str) -> OwnerCheck {
    if let Some(owner) = cached_owner(access_token) {
        return OwnerCheck::Owner(owner);
    }
    let result = fetch_claude_token_owner(client, access_token).await;
    if let OwnerCheck::Owner(owner) = &result {
        remember_owner(access_token, owner);
    }
    result
}

/// Only for a std thread outside Tokio (the live-sync watcher).
/// Calling this from inside an async runtime can panic at block_on.
pub fn claude_token_owner_blocking(access_token: &str) -> OwnerCheck {
    if let Some(owner) = cached_owner(access_token) {
        return OwnerCheck::Owner(owner);
    }
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    static RETRY: OnceLock<Mutex<HashMap<String, (Instant, Duration)>>> = OnceLock::new();
    let retries = RETRY.get_or_init(|| Mutex::new(HashMap::new()));
    let key = token_key(access_token);
    {
        let mut table = retries.lock().unwrap_or_else(|error| error.into_inner());
        table.retain(|_, (started, delay)| started.elapsed() < *delay);
        if table.contains_key(&key) {
            return OwnerCheck::Unavailable;
        }
    }
    let Some(client) = CLIENT.get_or_init(|| reqwest::Client::builder()
        .timeout(Duration::from_secs(15)).build().ok()) else {
            return OwnerCheck::Unavailable;
        };
    let result = tauri::async_runtime::block_on(fetch_claude_token_owner(client, access_token));
    let delay = match &result {
        OwnerCheck::Owner(owner) => {
            remember_owner(access_token, owner);
            return result;
        }
        OwnerCheck::Rejected { .. } => 600,
        OwnerCheck::RateLimited { retry_after_secs } => retry_after_secs.unwrap_or(120).max(120),
        OwnerCheck::Unavailable => 60,
    };
    retries.lock().unwrap_or_else(|error| error.into_inner())
        .insert(key, (Instant::now(), Duration::from_secs(delay)));
    result
}

#[derive(Debug, PartialEq, Eq)]
pub enum OwnerVerdict {
    Matches,
    Foreign(TokenOwner),
    Unverified,
}

pub fn verdict(claimed_identity: &str, owner: Option<&TokenOwner>) -> OwnerVerdict {
    match owner {
        Some(owner) if owner.account_uuid == claimed_identity => OwnerVerdict::Matches,
        Some(owner) => OwnerVerdict::Foreign(owner.clone()),
        None => OwnerVerdict::Unverified,
    }
}

pub fn claude_access_token(credentials_text: &str) -> Option<String> {
    crate::usage::credentials::claude_tokens(credentials_text).ok().map(|tokens| tokens.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> TokenOwner {
        TokenOwner { account_uuid: "owner-test".into(), email: Some("x@example.test".into()) }
    }

    #[test]
    fn parse_profile_requires_uuid_but_not_email() {
        assert_eq!(parse_profile_body(r#"{"account":{"uuid":"owner-test","email":"x@example.test"}}"#), Some(owner()));
        assert!(parse_profile_body(r#"{"account":{"email":"x@example.test"}}"#).is_none());
        assert!(parse_profile_body(r#"{"account":{"uuid":""}}"#).is_none());
        assert!(parse_profile_body(r#"{"account":{"uuid":" "}}"#).is_none());
        assert_eq!(parse_profile_body(r#"{"account":{"uuid":"owner-test"}}"#), Some(TokenOwner { email: None, ..owner() }));
    }

    #[test]
    fn profile_response_table() {
        let body = r#"{"account":{"uuid":"owner-test","email":"x@example.test"}}"#;
        for (status, retry, text, expected) in [
            (200, None, body, OwnerCheck::Owner(owner())),
            (204, None, "", OwnerCheck::Unavailable),
            (200, None, "broken", OwnerCheck::Unavailable),
            (401, None, body, OwnerCheck::Rejected { status: 401 }),
            (403, None, body, OwnerCheck::Rejected { status: 403 }),
            (429, Some(123), body, OwnerCheck::RateLimited { retry_after_secs: Some(123) }),
            (500, None, body, OwnerCheck::Unavailable),
        ] {
            assert_eq!(classify_profile_response(status, retry, text), expected);
        }
    }

    #[test]
    fn token_key_is_lowercase_sha256() {
        let key = token_key("owner-key-synthetic-token");
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)));
        assert!(!key.contains("owner-key-synthetic-token"));
        assert_eq!(token_key("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn owner_cache_round_trip() {
        let token = "owner-cache-round-trip-unique-token";
        assert!(cached_owner(token).is_none());
        remember_owner(token, &owner());
        assert_eq!(cached_owner(token), Some(owner()));
        // A hit never needs a runtime or a network request.
        assert_eq!(claude_token_owner_blocking(token), OwnerCheck::Owner(owner()));
    }

    #[test]
    fn verdict_table() {
        assert_eq!(verdict("owner-test", Some(&owner())), OwnerVerdict::Matches);
        assert_eq!(verdict("another", Some(&owner())), OwnerVerdict::Foreign(owner()));
        assert_eq!(verdict("owner-test", None), OwnerVerdict::Unverified);
    }
}
