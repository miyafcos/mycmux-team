//! Claude's name and tokens live in separate files, written by different processes.
//! A CLI started as X can overwrite the tokens while the name still says P.
//! Trust the profile endpoint, never the name alone; retain only hashed cache keys.

use std::{collections::HashMap, sync::{Mutex, OnceLock}, time::{Duration, Instant}};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenOwner {
    pub account_uuid: String,
    pub email: Option<String>,
    pub organization_uuid: Option<String>,
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
pub const CLAUDE_ORG_URL: &str = "https://api.anthropic.com/api/oauth/org";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrganizationCheck {
    Organization(String),
    Unavailable { status: Option<u16> },
}

/// Internal lookup result. Neither request secrets nor response bodies reach IPC.
pub struct LaunchOwnerCheck {
    pub profile: OwnerCheck,
    pub organization: Option<OrganizationCheck>,
}

impl From<OwnerCheck> for LaunchOwnerCheck {
    fn from(profile: OwnerCheck) -> Self { Self { profile, organization: None } }
}

pub fn classify_organization_response(status: u16, body: &str) -> OrganizationCheck {
    if (200..300).contains(&status) {
        if let Some(org) = serde_json::from_str::<serde_json::Value>(body).ok()
            .and_then(|value| value.get("organization_uuid")?.as_str().map(str::to_owned))
            .filter(|org| !org.trim().is_empty()) {
            return OrganizationCheck::Organization(org);
        }
    }
    OrganizationCheck::Unavailable { status: Some(status) }
}

const OWNER_RESPONSE_LIMIT: usize = 256 * 1024;

async fn read_owner_response(mut response: reqwest::Response) -> Result<String, ()> {
    if response.content_length().is_some_and(|length| length > OWNER_RESPONSE_LIMIT as u64) {
        return Err(());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if chunk.len() > OWNER_RESPONSE_LIMIT - body.len() { return Err(()); }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| ())
}

pub async fn fetch_claude_token_organization_at(client: &reqwest::Client, token: &str, url: &str) -> OrganizationCheck {
    let Ok(response) = client.post(url).bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, crate::usage::oauth_claude::claude_cli_user_agent())
        .send().await else { return OrganizationCheck::Unavailable { status: None } };
    let status = response.status().as_u16();
    let Ok(body) = read_owner_response(response).await else { return OrganizationCheck::Unavailable { status: Some(status) } };
    classify_organization_response(status, &body)
}

// Only the explicit two-stage launch-token lookup uses this transport.
fn launch_owner_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .timeout(Duration::from_secs(6))
}

/// Both lookups share the existing six-second budget. Leave time for the fallback.
pub async fn fetch_claude_launch_owner(token: &str) -> LaunchOwnerCheck {
    let Ok(client) = launch_owner_client_builder().build() else {
        return LaunchOwnerCheck { profile: OwnerCheck::Unavailable,
            organization: Some(OrganizationCheck::Unavailable { status: None }) };
    };
    fetch_claude_launch_owner_at(&client, token, CLAUDE_PROFILE_URL, CLAUDE_ORG_URL).await
}

async fn fetch_claude_launch_owner_at(client: &reqwest::Client, token: &str, profile_url: &str, org_url: &str) -> LaunchOwnerCheck {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    let profile = tokio::time::timeout(Duration::from_secs(3),
        fetch_claude_token_owner_at(client, token, profile_url)).await.unwrap_or(OwnerCheck::Unavailable);
    let organization = if matches!(profile, OwnerCheck::Owner(_)) { None } else {
        Some(tokio::time::timeout_at(deadline,
            fetch_claude_token_organization_at(client, token, org_url)).await
            .unwrap_or(OrganizationCheck::Unavailable { status: None }))
    };
    LaunchOwnerCheck { profile, organization }
}

pub fn token_key(access_token: &str) -> String {
    hex::encode(Sha256::digest(access_token.as_bytes()))
}

#[derive(Clone)]
struct CachedProfile {
    owner: TokenOwner,
    subscription: Option<crate::usage::subscription::AccountSubscription>,
    checked_at: Instant,
    refresh_after: Duration,
    last_attempt_failed: bool,
}

fn owners() -> &'static Mutex<HashMap<String, CachedProfile>> {
    static OWNERS: OnceLock<Mutex<HashMap<String, CachedProfile>>> = OnceLock::new();
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cached_owner(access_token: &str) -> Option<TokenOwner> {
    owners().lock().unwrap_or_else(|error| error.into_inner())
        .get(&token_key(access_token)).map(|profile| profile.owner.clone())
}

pub fn profile_refresh_due(access_token: &str) -> bool {
    owners().lock().unwrap_or_else(|error| error.into_inner())
        .get(&token_key(access_token)).is_none_or(|profile| profile.checked_at.elapsed() >= profile.refresh_after)
}

/// Reserve an optional metadata refresh before awaiting I/O; concurrent polls reuse it.
pub fn claim_profile_refresh(access_token: &str) -> bool {
    let mut cache = owners().lock().unwrap_or_else(|error| error.into_inner());
    let Some(profile) = cache.get_mut(&token_key(access_token)) else { return false };
    if profile.checked_at.elapsed() < profile.refresh_after { return false; }
    profile.checked_at = Instant::now();
    profile.refresh_after = Duration::from_millis(crate::usage::subscription::SUBSCRIPTION_CACHE_TTL_MS as u64);
    profile.last_attempt_failed = true;
    true
}

/// A deliberate refresh can shorten a successful cache, never a failed request's backoff.
pub fn request_profile_refresh(access_token: &str) {
    if let Some(profile) = owners().lock().unwrap_or_else(|error| error.into_inner())
        .get_mut(&token_key(access_token)) {
        if !profile.last_attempt_failed && profile.checked_at.elapsed() >= Duration::from_secs(60) {
            profile.refresh_after = Duration::ZERO;
        }
    }
}

pub fn defer_profile_refresh(access_token: &str, retry_after_secs: Option<u64>) {
    if let Some(profile) = owners().lock().unwrap_or_else(|error| error.into_inner())
        .get_mut(&token_key(access_token)) {
        profile.checked_at = Instant::now();
        profile.last_attempt_failed = true;
        profile.refresh_after = Duration::from_secs(retry_after_secs.unwrap_or(0)
            .max(crate::usage::subscription::SUBSCRIPTION_CACHE_TTL_MS as u64 / 1000));
    }
}

pub fn cached_subscription(access_token: &str) -> Option<crate::usage::subscription::AccountSubscription> {
    owners().lock().unwrap_or_else(|error| error.into_inner())
        .get(&token_key(access_token)).and_then(|profile| profile.subscription.clone())
}

pub fn remember_owner(access_token: &str, owner: &TokenOwner) {
    let mut cache = owners().lock().unwrap_or_else(|error| error.into_inner());
    // ponytail: cap at 256 entries; use LRU eviction if rotation churn makes clearing costly.
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.entry(token_key(access_token)).and_modify(|profile| {
        if profile.owner != *owner {
            profile.owner = owner.clone();
            profile.subscription = None;
            profile.last_attempt_failed = false;
            profile.checked_at = Instant::now();
            profile.refresh_after = Duration::ZERO;
        }
    }).or_insert_with(|| CachedProfile { owner: owner.clone(), subscription: None,
        checked_at: Instant::now(),
        refresh_after: Duration::ZERO,
        last_attempt_failed: false });
}

pub fn parse_profile_body(body: &str) -> Option<TokenOwner> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let account = value.get("account")?;
    let uuid = account.get("uuid")?.as_str().filter(|uuid| !uuid.trim().is_empty())?;
    Some(TokenOwner {
        account_uuid: uuid.to_string(),
        email: account.get("email").and_then(serde_json::Value::as_str).map(str::to_string),
        organization_uuid: value.pointer("/organization/uuid")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
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
    fetch_claude_token_owner_at(client, access_token, CLAUDE_PROFILE_URL).await
}

pub async fn fetch_claude_token_owner_at(
    client: &reqwest::Client,
    access_token: &str,
    url: &str,
) -> OwnerCheck {
    let Ok(response) = client
        .get(url)
        .bearer_auth(access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, crate::usage::oauth_claude::claude_cli_user_agent())
        .send().await else {
            return OwnerCheck::Unavailable;
        };
    let status = response.status().as_u16();
    let retry_after_secs = response.headers().get("retry-after")
        .and_then(|value| value.to_str().ok()).and_then(|value| value.parse().ok());
    let Ok(body) = read_owner_response(response).await else {
        return OwnerCheck::Unavailable;
    };
    let result = classify_profile_response(status, retry_after_secs, &body);
    if let OwnerCheck::Owner(owner) = &result {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
            let info = crate::usage::subscription::claude_profile(&value, chrono::Utc::now().to_rfc3339());
            let mut cache = owners().lock().unwrap_or_else(|error| error.into_inner());
            if cache.len() >= 256 { cache.clear(); }
            cache.insert(token_key(access_token), CachedProfile { owner: owner.clone(),
                subscription: Some(info), checked_at: Instant::now(),
                refresh_after: Duration::from_millis(crate::usage::subscription::SUBSCRIPTION_CACHE_TTL_MS as u64),
                last_attempt_failed: false });
        }
    }
    result
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
        TokenOwner {
            account_uuid: "owner-test".into(),
            email: Some("x@example.test".into()),
            organization_uuid: None,
        }
    }

    #[test]
    fn parse_profile_requires_uuid_but_not_email() {
        assert_eq!(parse_profile_body(r#"{"account":{"uuid":"owner-test","email":"x@example.test"}}"#), Some(owner()));
        assert!(parse_profile_body(r#"{"account":{"email":"x@example.test"}}"#).is_none());
        assert!(parse_profile_body(r#"{"account":{"uuid":""}}"#).is_none());
        assert!(parse_profile_body(r#"{"account":{"uuid":" "}}"#).is_none());
        assert_eq!(parse_profile_body(r#"{"account":{"uuid":"owner-test"}}"#), Some(TokenOwner { email: None, ..owner() }));
        let with_org = parse_profile_body(
            r#"{"account":{"uuid":"owner-test"},"organization":{"uuid":"org-test"}}"#,
        ).unwrap();
        assert_eq!(with_org.organization_uuid.as_deref(), Some("org-test"));
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
        assert!(profile_refresh_due(token));
        // A hit never needs a runtime or a network request.
        assert_eq!(claude_token_owner_blocking(token), OwnerCheck::Owner(owner()));
    }

    #[test]
    fn expired_metadata_and_failed_refresh_keep_verified_identity_and_subscription() {
        let token = "profile-expiry-unique-synthetic";
        remember_owner(token, &owner());
        let info = crate::usage::subscription::claude_profile(
            &serde_json::json!({"organization":{"organization_type":"claude_free"}}), "checked".into());
        {
            let mut cache = owners().lock().unwrap_or_else(|error| error.into_inner());
            let cached = cache.get_mut(&token_key(token)).unwrap();
            cached.subscription = Some(info.clone());
            cached.checked_at = Instant::now() - Duration::from_millis(
                crate::usage::subscription::SUBSCRIPTION_CACHE_TTL_MS as u64);
        }
        assert!(profile_refresh_due(token));
        assert_eq!(cached_owner(token), Some(owner()));
        assert_eq!(cached_subscription(token), Some(info.clone()));
        defer_profile_refresh(token, Some(1800));
        assert!(!profile_refresh_due(token));
        assert_eq!(cached_subscription(token), Some(info));
        request_profile_refresh(token);
        assert!(!profile_refresh_due(token));
    }

    #[test]
    fn manual_refresh_can_expire_a_successful_cache_after_one_minute() {
        let token = "manual-profile-refresh-unique-synthetic";
        remember_owner(token, &owner());
        {
            let mut cache = owners().lock().unwrap_or_else(|error| error.into_inner());
            let cached = cache.get_mut(&token_key(token)).unwrap();
            cached.subscription = Some(crate::usage::subscription::claude_profile(
                &serde_json::json!({"organization":{"organization_type":"claude_pro"}}), "checked".into()));
            cached.refresh_after = Duration::from_millis(crate::usage::subscription::SUBSCRIPTION_CACHE_TTL_MS as u64);
        }
        request_profile_refresh(token);
        assert!(!profile_refresh_due(token));
        owners().lock().unwrap_or_else(|error| error.into_inner())
            .get_mut(&token_key(token)).unwrap().checked_at = Instant::now() - Duration::from_secs(61);
        request_profile_refresh(token);
        assert!(profile_refresh_due(token));
        assert!(claim_profile_refresh(token));
        assert!(!claim_profile_refresh(token));
        request_profile_refresh(token);
        assert!(!profile_refresh_due(token));
        assert_eq!(cached_owner(token), Some(owner()));
    }

    #[tokio::test]
    async fn profile_fetch_keeps_fresh_plan_when_the_owner_is_remembered_again() {
        let (base, request) = crate::usage::reset_tickets::fake_http_once(
            r#"{"account":{"uuid":"owner-test"},"organization":{"organization_type":"claude_free"}}"#).await;
        let token = "profile-plan-preserve-unique-synthetic";
        let check = fetch_claude_token_owner_at(&reqwest::Client::new(), token, &base).await;
        let OwnerCheck::Owner(owner) = check else { panic!("profile rejected") };
        remember_owner(token, &owner);
        assert_eq!(cached_subscription(token).unwrap().plan.as_deref(), Some("free"));
        assert!(cached_owner(token).is_some());
        assert!(request.await.unwrap().starts_with("GET / "));
    }

    #[test]
    fn v1_organization_response_accepts_only_nonempty_string_and_never_returns_body() {
        for body in [r#"{}"#, r#"{"organization_uuid":null}"#, r#"{"organization_uuid":7}"#,
            r#"{"organization_uuid":""}"#, r#"{"organization_uuid":"  "}"#, "synthetic-secret-body"] {
            assert_eq!(classify_organization_response(200, body), OrganizationCheck::Unavailable { status: Some(200) });
        }
        assert_eq!(classify_organization_response(200, r#"{"organization_uuid":"org-1"}"#),
            OrganizationCheck::Organization("org-1".into()));
        assert_eq!(classify_organization_response(403, "synthetic-secret-body"),
            OrganizationCheck::Unavailable { status: Some(403) });
    }

    #[tokio::test]
    async fn v1_launch_lookup_falls_back_to_bodyless_org_post_only_without_profile_owner() {
        let (profile, profile_request) = crate::usage::reset_tickets::fake_http_once("{}").await;
        let (org, org_request) = crate::usage::reset_tickets::fake_http_once(r#"{"organization_uuid":"org-1"}"#).await;
        let result = fetch_claude_launch_owner_at(&reqwest::Client::new(), "synthetic-launch-token", &profile, &org).await;
        assert_eq!(result.profile, OwnerCheck::Unavailable);
        assert_eq!(result.organization, Some(OrganizationCheck::Organization("org-1".into())));
        assert!(profile_request.await.unwrap().starts_with("GET / "));
        let request = org_request.await.unwrap();
        assert!(request.starts_with("POST / "));
        assert!(request.to_lowercase().contains("authorization: bearer synthetic-launch-token"));
        assert!(request.to_lowercase().contains("content-type: application/json"));
        assert!(request.ends_with("\r\n\r\n"));
        let (profile, request) = crate::usage::reset_tickets::fake_http_once(
            r#"{"account":{"uuid":"owner-test"}}"#).await;
        let result = fetch_claude_launch_owner_at(&reqwest::Client::new(), "synthetic-profile-token", &profile, "invalid-org-url").await;
        assert!(matches!(result.profile, OwnerCheck::Owner(_)));
        assert_eq!(result.organization, None);
        assert!(request.await.unwrap().starts_with("GET / "));
    }


    fn rv02_test_client() -> reqwest::Client {
        // Only HTTPS-only is relaxed for the fake HTTP servers. Keep the production redirect policy.
        launch_owner_client_builder().https_only(false).build().unwrap()
    }

    async fn rv_read_request(stream: &mut tokio::net::TcpStream) {
        use tokio::io::AsyncReadExt;
        let mut request = Vec::new();
        let mut buffer = [0u8; 1024];
        while !request.windows(4).any(|part| part == b"\r\n\r\n") {
            let size = stream.read(&mut buffer).await.unwrap();
            if size == 0 { break; }
            request.extend_from_slice(&buffer[..size]);
        }
    }

    async fn rv_fake_http(status: u16, headers: String, body: Vec<u8>, length: bool)
        -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            rv_read_request(&mut stream).await;
            let length = if length { format!("Content-Length: {}\r\n", body.len()) } else { String::new() };
            let head = format!("HTTP/1.1 {status} Fixture\r\n{headers}{length}Content-Type: application/json\r\nConnection: close\r\n\r\n");
            // A capped reader may close as soon as it sees a large declared length.
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(&body).await;
        });
        (url, handle)
    }

    async fn rv02_assert_redirect(status: u16, organization: bool) {
        use tokio::io::AsyncWriteExt;
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_url = format!("http://{}/redirected", target.local_addr().unwrap());
        let reached = tokio::spawn(async move {
            let Ok(Ok((mut stream, _))) = tokio::time::timeout(Duration::from_millis(500), target.accept()).await else { return false };
            rv_read_request(&mut stream).await;
            let body = r#"{"account":{"uuid":"redirect-owner"},"organization_uuid":"redirect-org"}"#;
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(reply.as_bytes()).await;
            true
        });
        let (url, response) = rv_fake_http(status, format!("Location: {target_url}\r\n"), vec![], true).await;
        let client = rv02_test_client();
        if organization {
            let result = fetch_claude_token_organization_at(&client, "rv02-synthetic", &url).await;
            assert!(!reached.await.unwrap(), "redirect target received an organization request");
            assert_eq!(result, OrganizationCheck::Unavailable { status: Some(status) });
        } else {
            let result = fetch_claude_token_owner_at(&client, "rv02-synthetic", &url).await;
            assert!(!reached.await.unwrap(), "redirect target received a profile request");
            assert_eq!(result, OwnerCheck::Unavailable);
        }
        response.await.unwrap();
    }

    macro_rules! rv02_redirect_case {
        ($name:ident, $status:expr, $organization:expr) => {
            #[tokio::test]
            async fn $name() { rv02_assert_redirect($status, $organization).await; }
        };
    }
    rv02_redirect_case!(rv02_profile_does_not_follow_302, 302, false);
    rv02_redirect_case!(rv02_profile_does_not_follow_307, 307, false);
    rv02_redirect_case!(rv02_profile_does_not_follow_308, 308, false);
    rv02_redirect_case!(rv02_org_does_not_follow_302, 302, true);
    rv02_redirect_case!(rv02_org_does_not_follow_307, 307, true);
    rv02_redirect_case!(rv02_org_does_not_follow_308, 308, true);

    async fn rv03_assert_body(organization: bool, length: bool, status: u16, extra: usize) {
        let mut body = if organization { br#"{"organization_uuid":"rv03-org"}"#.to_vec() }
            else { br#"{"account":{"uuid":"rv03-owner"}}"#.to_vec() };
        body.resize(256 * 1024 + extra, b' ');
        let (url, response) = rv_fake_http(status, String::new(), body, length).await;
        let client = rv02_test_client();
        if organization {
            let result = fetch_claude_token_organization_at(&client, "rv03-synthetic", &url).await;
            let expected = if extra == 0 && status == 200 { OrganizationCheck::Organization("rv03-org".into()) }
                else { OrganizationCheck::Unavailable { status: Some(status) } };
            assert_eq!(result, expected);
        } else {
            let result = fetch_claude_token_owner_at(&client, "rv03-synthetic", &url).await;
            let expected = if extra == 0 && status == 200 {
                OwnerCheck::Owner(TokenOwner { account_uuid: "rv03-owner".into(), email: None, organization_uuid: None })
            } else { OwnerCheck::Unavailable };
            assert_eq!(result, expected);
        }
        response.await.unwrap();
    }

    macro_rules! rv03_body_case {
        ($name:ident, $org:expr, $length:expr, $status:expr, $extra:expr) => {
            #[tokio::test]
            async fn $name() { rv03_assert_body($org, $length, $status, $extra).await; }
        };
    }
    rv03_body_case!(rv03_profile_rejects_limit_plus_one_with_length, false, true, 200, 1);
    rv03_body_case!(rv03_profile_rejects_limit_plus_one_without_length, false, false, 200, 1);
    rv03_body_case!(rv03_org_rejects_limit_plus_one_with_length, true, true, 200, 1);
    rv03_body_case!(rv03_org_rejects_limit_plus_one_without_length, true, false, 200, 1);
    rv03_body_case!(rv03_profile_accepts_exact_limit_with_length, false, true, 200, 0);
    rv03_body_case!(rv03_profile_accepts_exact_limit_without_length, false, false, 200, 0);
    rv03_body_case!(rv03_org_accepts_exact_limit_with_length, true, true, 200, 0);
    rv03_body_case!(rv03_org_accepts_exact_limit_without_length, true, false, 200, 0);
    rv03_body_case!(rv03_profile_caps_large_403_with_length, false, true, 403, 1);
    rv03_body_case!(rv03_profile_caps_large_403_without_length, false, false, 403, 1);
    rv03_body_case!(rv03_org_caps_large_403_with_length, true, true, 403, 1);
    rv03_body_case!(rv03_org_caps_large_403_without_length, true, false, 403, 1);

    #[test]
    fn verdict_table() {
        assert_eq!(verdict("owner-test", Some(&owner())), OwnerVerdict::Matches);
        assert_eq!(verdict("another", Some(&owner())), OwnerVerdict::Foreign(owner()));
        assert_eq!(verdict("owner-test", None), OwnerVerdict::Unverified);
    }
}
