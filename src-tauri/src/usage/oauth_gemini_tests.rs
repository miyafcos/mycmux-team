use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex as StdMutex;

impl UsageCache {
    async fn fetch_with(
        &self, source: &impl Source, now: impl Fn() -> DateTime<Utc>, explicit: bool,
    ) -> ProfileUsage {
        self.fetch_snapshot_with(source, &now, explicit).await.report_at(now()).1
    }
}

const CREDENTIAL: &[u8] = br#"{
    "token": {
        "access_token": "fixture-access",
        "token_type": "Bearer",
        "refresh_token": "fixture-refresh",
        "expiry": "2026-11-19T00:01:50.7892918+09:00",
        "expires_in": 3600
    },
    "auth_method": "consumer",
    "id_token_email": "agy@example.test"
}"#;

fn utc(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}

fn before_expiry() -> DateTime<Utc> {
    utc("2026-11-18T15:01:50.7892917Z")
}

fn at_expiry() -> DateTime<Utc> {
    utc("2026-11-18T15:01:50.7892918Z")
}

type Exchange = (&'static str, Value, Result<Value, UsageError>);

struct Fixture {
    credentials: Result<&'static [u8], UsageError>,
    reads: AtomicUsize,
    posts: AtomicUsize,
    exchanges: StdMutex<VecDeque<Exchange>>,
}

impl Fixture {
    fn new(exchanges: Vec<Exchange>) -> Self {
        Self {
            credentials: Ok(CREDENTIAL),
            reads: AtomicUsize::new(0),
            posts: AtomicUsize::new(0),
            exchanges: StdMutex::new(exchanges.into()),
        }
    }

    fn assert_finished(&self) {
        assert!(self.exchanges.lock().unwrap().is_empty());
    }
}

impl Source for Fixture {
    fn credentials(&self) -> Result<Credentials, UsageError> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        parse_credentials(self.credentials?)
    }

    async fn post(
        &self,
        method: &'static str,
        token: &str,
        body: Value,
    ) -> Result<Value, UsageError> {
        tokio::task::yield_now().await;
        let (expected_method, expected_body, response) = self
            .exchanges
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected network request");
        assert_eq!(method, expected_method);
        assert_eq!(body, expected_body);
        assert!(token == "fixture-access");
        self.posts.fetch_add(1, Ordering::Relaxed);
        response
    }
}

fn load(response: Result<Value, UsageError>) -> Exchange {
    (
        LOAD_PROJECT,
        json!({"metadata": {"ideType": "ANTIGRAVITY"}}),
        response,
    )
}

fn default_models() -> Value {
    serde_json::from_str(include_str!("testdata/gemini_models_default.json")).unwrap()
}

fn project_models() -> Value {
    serde_json::from_str(include_str!("testdata/gemini_models_project.json")).unwrap()
}

fn summary(row: &ProfileUsage) -> Vec<(&str, f64, &str)> {
    row.model_windows
        .iter()
        .map(|item| {
            (
                item.key.as_str(),
                item.window.pct,
                item.window.resets_at.as_str(),
            )
        })
        .collect()
}

#[tokio::test]
async fn gemini_reports_missing_quota_windows_separately_from_zero_usage() {
    for models in [
        json!({}),
        json!({
            "tab_ignored": {"quotaInfo": {"remainingFraction": 0.5}},
            "gemini-3-flash": {"quotaInfo": {}},
        }),
    ] {
        let source = Fixture::new(vec![
            load(Ok(json!({}))),
            (FETCH_MODELS, json!({}), Ok(json!({"models": models}))),
        ]);
        let cache = UsageCache::default();
        for _ in 0..2 {
            let row = cache.fetch_with(&source, before_expiry, false).await;
            assert_eq!(row.state, UsageRowState::Error);
            assert_eq!(row.error_code.as_deref(), Some("usage.error.gemini_no_usage"));
            assert!(row.model_windows.is_empty());
        }
        assert_eq!(source.posts.load(Ordering::Relaxed), 2);
        source.assert_finished();
    }

    let source = Fixture::new(vec![
        load(Ok(json!({}))),
        (FETCH_MODELS, json!({}), Ok(json!({"models": {
            "gemini-3-pro": {"quotaInfo": {}},
            "gemini-3-flash": {"quotaInfo": {"remainingFraction": 1.0}},
        }}))),
    ]);
    let (row, _) = fetch_row(&source, before_expiry()).await;
    assert_eq!(row.state, UsageRowState::Ok);
    assert_eq!(summary(&row), vec![("Flash", 0.0, "")]);
    source.assert_finished();
}

async fn fetch_row_with_clock(
    source: &impl Source,
    now: impl Fn() -> DateTime<Utc>,
) -> (ProfileUsage, Option<DateTime<FixedOffset>>) {
    let cache = UsageCache::default();
    let row = cache.fetch_with(source, now, false).await;
    (row, cache.snapshot().and_then(|entry| entry.expiry))
}

async fn fetch_row(source: &impl Source, now: DateTime<Utc>) -> (ProfileUsage, Option<DateTime<FixedOffset>>) {
    fetch_row_with_clock(source, || now).await
}

async fn advance_cache(cache: &UsageCache, elapsed: Duration) {
    if let Some(at) = cache.schedule.lock().await.next_request_at.as_mut() { *at -= elapsed; }
    if let Some(entry) = cache.latest.lock().unwrap().as_mut() { entry.fresh_until -= elapsed; }
}

#[tokio::test]
async fn default_request_falls_back_when_project_is_unavailable() {
    for loaded in [
        Err(UsageError::Fetch),
        Ok(json!({"cloudaicompanionProject": {"id": ""}})),
    ] {
        let source = Fixture::new(vec![
            load(loaded),
            (FETCH_MODELS, json!({}), Ok(default_models())),
        ]);
        let (row, _) = fetch_row(&source, before_expiry()).await;
        assert_eq!(row.email.as_deref(), Some("agy@example.test"));
        assert_eq!(row.state, UsageRowState::Ok);
        assert_eq!(
            summary(&row),
            vec![
                ("Pro", 25.0, "2026-11-20T00:00:00+00:00"),
                ("Flash", 50.0, "")
            ]
        );
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["provider"], "gemini");
        assert_eq!(json["label"], "Gemini");
        assert!(!json.to_string().contains("fixture-access"));
        assert!(!json.to_string().contains("fixture-refresh"));
        source.assert_finished();
    }
}

#[tokio::test]
async fn project_request_takes_the_minimum_remaining_fraction_per_group() {
    for project in [json!("fixture-project"), json!({"id": "fixture-project"})] {
        let source = Fixture::new(vec![
            load(Ok(json!({"cloudaicompanionProject": project}))),
            (
                FETCH_MODELS,
                json!({"project": "fixture-project"}),
                Ok(project_models()),
            ),
        ]);
        let (row, _) = fetch_row(&source, before_expiry()).await;
        assert_eq!(row.state, UsageRowState::Ok);
        assert_eq!(
            summary(&row),
            vec![
                ("Pro", 75.0, "2026-11-21T11:00:00+00:00"),
                ("Flash", 87.5, "2026-11-21T12:00:00+00:00"),
                ("Claude", 100.0, ""),
            ]
        );
        source.assert_finished();
    }
}

#[tokio::test]
async fn seven_digit_expiry_is_checked_before_any_request() {
    let source = Fixture::new(vec![]);
    assert_eq!(
        parse_credentials(CREDENTIAL).unwrap().token.expiry,
        at_expiry()
    );
    let (row, expiry) = fetch_row(&source, at_expiry()).await;
    assert_eq!(expiry.unwrap(), at_expiry());
    assert_eq!(row.state, UsageRowState::WaitForCli);
    assert_eq!(
        row.error_code.as_deref(),
        Some("usage.error.gemini_expired")
    );
    assert_eq!(row.email.as_deref(), Some("agy@example.test"));
    assert!(row.model_windows.is_empty());
    source.assert_finished();
}

#[tokio::test]
async fn authentication_status_and_other_failures_are_distinct() {
    for (source, error_code) in [
        (
            Fixture::new(vec![load(Err(http_error(
                reqwest::StatusCode::UNAUTHORIZED,
            )))]),
            "usage.error.gemini_expired",
        ),
        (
            Fixture::new(vec![
                load(Ok(json!({}))),
                (
                    FETCH_MODELS,
                    json!({}),
                    Err(http_error(reqwest::StatusCode::FORBIDDEN)),
                ),
            ]),
            "usage.error.gemini_expired",
        ),
        (
            Fixture::new(vec![
                load(Ok(json!({}))),
                (FETCH_MODELS, json!({}), Ok(json!({}))),
            ]),
            "usage.error.gemini_fetch",
        ),
        (
            Fixture {
                credentials: Ok(b"invalid blob"),
                ..Fixture::new(vec![])
            },
            "usage.error.gemini_credentials",
        ),
        (
            Fixture {
                credentials: Err(UsageError::NotSignedIn),
                ..Fixture::new(vec![])
            },
            "usage.error.gemini_not_signed_in",
        ),
        (
            Fixture {
                credentials: Err(UsageError::Unsupported),
                ..Fixture::new(vec![])
            },
            "usage.error.gemini_unsupported",
        ),
    ] {
        let (row, _) = fetch_row(&source, before_expiry()).await;
        assert_eq!(row.error_code.as_deref(), Some(error_code));
        assert!(row.model_windows.is_empty());
        source.assert_finished();
    }
}

#[tokio::test]
async fn concurrent_polls_share_the_cache_and_do_not_hide_expiry() {
    let source = Fixture::new(vec![
        load(Err(UsageError::Fetch)),
        (FETCH_MODELS, json!({}), Ok(default_models())),
        load(Ok(json!({}))),
        (FETCH_MODELS, json!({}), Ok(default_models())),
    ]);
    let cache = UsageCache::default();
    let (first, second) = tokio::join!(
        cache.fetch_with(&source, before_expiry, false),
        cache.fetch_with(&source, before_expiry, false),
    );
    assert_eq!(summary(&first), summary(&second));
    assert_eq!(source.reads.load(Ordering::Relaxed), 1);
    let expired = cache.fetch_with(&source, at_expiry, false).await;
    assert_eq!(
        expired.error_code.as_deref(),
        Some("usage.error.gemini_expired")
    );
    assert!(expired.model_windows.is_empty());
    assert_eq!(source.reads.load(Ordering::Relaxed), 1);
    advance_cache(&cache, CACHE_TTL).await;
    assert_eq!(
        cache.fetch_with(&source, before_expiry, false).await.state,
        UsageRowState::Ok
    );
    assert_eq!(source.reads.load(Ordering::Relaxed), 2);
    source.assert_finished();
}

#[tokio::test]
async fn gemini_checks_expiry_before_each_post_and_before_returning() {
    for post_count in 0..=2 {
        let mut exchanges = vec![load(Ok(json!({}))), (FETCH_MODELS, json!({}), Ok(default_models()))];
        exchanges.truncate(post_count);
        let source = Fixture::new(exchanges);
        let (row, _) = fetch_row_with_clock(&source, || {
            if source.reads.load(Ordering::Relaxed) > 0 && source.posts.load(Ordering::Relaxed) >= post_count {
                at_expiry()
            } else {
                before_expiry()
            }
        }).await;
        assert_eq!(row.error_code.as_deref(), Some("usage.error.gemini_expired"));
        assert!(row.model_windows.is_empty());
        assert_eq!(source.posts.load(Ordering::Relaxed), post_count);
        source.assert_finished();
    }
}

#[tokio::test]
async fn gemini_project_429_does_not_attempt_the_empty_body_fallback() {
    let source = Fixture::new(vec![load(Err(http_error(reqwest::StatusCode::TOO_MANY_REQUESTS)))]);
    let row = UsageCache::default().fetch_with(&source, before_expiry, false).await;
    assert_eq!(row.error_code.as_deref(), Some("usage.error.rate_limited"));
    assert_eq!(row.state, UsageRowState::Cooldown);
    assert_eq!(row.retry_at, Some((before_expiry() + chrono::TimeDelta::seconds(300)).to_rfc3339()));
    assert_eq!(source.posts.load(Ordering::Relaxed), 1);
    source.assert_finished();
}

#[tokio::test]
async fn gemini_429_uses_the_existing_backoff_and_clears_it_on_success() {
    let limited = http_error(reqwest::StatusCode::TOO_MANY_REQUESTS);
    let source = Fixture::new(vec![
        load(Err(limited)),
        load(Ok(json!({}))), (FETCH_MODELS, json!({}), Err(limited)),
        load(Err(limited)),
        load(Err(limited)),
        load(Err(limited)),
        load(Ok(json!({}))), (FETCH_MODELS, json!({}), Ok(default_models())),
        load(Err(limited)),
    ]);
    let cache = UsageCache::default();
    for (delay, posts) in [(300, 1), (600, 3), (1200, 4), (1800, 5), (1800, 6)] {
        let row = cache.fetch_with(&source, before_expiry, false).await;
        assert_eq!(row.error_code.as_deref(), Some("usage.error.rate_limited"));
        assert_eq!(row.retry_at, Some((before_expiry() + chrono::TimeDelta::seconds(delay)).to_rfc3339()));
        assert_eq!(cache.schedule.lock().await.backoff_ms, Some(delay * 1_000));
        advance_cache(&cache, Duration::from_secs(delay as u64 - 5)).await;
        for explicit in [false, true] {
            cache.fetch_with(&source, before_expiry, explicit).await;
            assert_eq!(source.posts.load(Ordering::Relaxed), posts);
        }
        advance_cache(&cache, Duration::from_secs(6)).await;
    }
    assert_eq!(cache.fetch_with(&source, before_expiry, false).await.state, UsageRowState::Ok);
    assert_eq!(cache.schedule.lock().await.backoff_ms, None);
    advance_cache(&cache, CACHE_TTL).await;
    cache.fetch_with(&source, before_expiry, false).await;
    assert_eq!(cache.schedule.lock().await.backoff_ms, Some(300_000));
    source.assert_finished();
}

#[tokio::test]
async fn gemini_manual_refresh_drops_quota_from_a_previous_login() {
    let replacement = br#"{"token":{"access_token":"fixture-access","expiry":"2026-11-20T15:00:00Z"},"id_token_email":"agy@example.test"}"#;
    let changed_email = br#"{"token":{"access_token":"fixture-access","expiry":"2026-11-19T00:01:50.7892918+09:00"},"id_token_email":"other@example.test"}"#;
    for (credentials, expected_email) in [(replacement.as_slice(), "agy@example.test"), (changed_email.as_slice(), "other@example.test")] {
        let original = Fixture::new(vec![load(Ok(json!({}))), (FETCH_MODELS, json!({}), Ok(default_models()))]);
        let cache = UsageCache::default();
        assert!(!cache.fetch_with(&original, before_expiry, false).await.model_windows.is_empty());
        original.assert_finished();

        let changed = Fixture { credentials: Ok(credentials), ..Fixture::new(vec![
            load(Ok(json!({}))), (FETCH_MODELS, json!({}), Ok(default_models())),
        ]) };
        let row = cache.fetch_with(&changed, before_expiry, true).await;
        assert_eq!(row.email.as_deref(), Some(expected_email));
        assert!(row.model_windows.is_empty());
        assert_eq!(row.error_code.as_deref(), Some("usage.error.deferred"));
        assert!(row.retry_at.is_none());
        assert_eq!(row.state, UsageRowState::Cooldown);
        assert_eq!(changed.reads.load(Ordering::Relaxed), 1);
        assert_eq!(changed.posts.load(Ordering::Relaxed), 0);
        advance_cache(&cache, CACHE_TTL - Duration::from_secs(5)).await;
        let waiting = cache.fetch_with(&changed, before_expiry, false).await;
        assert_eq!(waiting.error_code, row.error_code);
        assert_eq!(waiting.email.as_deref(), Some(expected_email));
        assert!(waiting.model_windows.is_empty());
        assert_eq!(changed.posts.load(Ordering::Relaxed), 0);
        advance_cache(&cache, Duration::from_secs(6)).await;
        let resumed = cache.fetch_with(&changed, before_expiry, false).await;
        assert_eq!(resumed.state, UsageRowState::Ok);
        assert!(!resumed.model_windows.is_empty());
        changed.assert_finished();
    }
}

#[tokio::test]
async fn gemini_changed_login_keeps_the_429_resume_time_past_the_next_poll() {
    let started = utc("2026-11-18T15:00:00Z");
    let resume_time = (started + chrono::TimeDelta::seconds(300)).to_rfc3339();
    let original = Fixture::new(vec![load(Err(UsageError::RateLimited))]);
    let cache = UsageCache::default();
    let limited = cache.fetch_with(&original, || started, false).await;
    original.assert_finished();

    let replacement = br#"{"token":{"access_token":"fixture-access","expiry":"2026-11-20T15:00:00Z"},"id_token_email":"other@example.test"}"#;
    let changed = Fixture { credentials: Ok(replacement), ..Fixture::new(vec![
        load(Ok(json!({}))), (FETCH_MODELS, json!({}), Ok(default_models())),
    ]) };
    let waiting = cache.fetch_with(&changed, || started, true).await;
    assert_eq!(waiting.email.as_deref(), Some("other@example.test"));
    assert_eq!(waiting.state, UsageRowState::Cooldown);
    assert_eq!(waiting.error_code.as_deref(), Some("usage.error.rate_limited"));
    assert_eq!(waiting.retry_at.as_deref(), Some(resume_time.as_str()));
    assert_eq!(limited.retry_at, waiting.retry_at);
    assert!(waiting.model_windows.is_empty());
    assert_eq!(changed.posts.load(Ordering::Relaxed), 0);

    advance_cache(&cache, Duration::from_secs(180)).await;
    let next_poll = || started + chrono::TimeDelta::seconds(180);
    let waiting_next_poll = cache.fetch_with(&changed, next_poll, false).await;
    assert_eq!(waiting_next_poll.retry_at, waiting.retry_at);
    assert!(waiting_next_poll.model_windows.is_empty());
    assert_eq!(changed.posts.load(Ordering::Relaxed), 0);

    advance_cache(&cache, Duration::from_secs(120)).await;
    let resumed = cache.fetch_with(&changed, || started + chrono::TimeDelta::seconds(300), false).await;
    assert_eq!(resumed.state, UsageRowState::Ok);
    assert!(resumed.retry_at.is_none());
    assert!(!resumed.model_windows.is_empty());
    assert_eq!(changed.posts.load(Ordering::Relaxed), 2);
    changed.assert_finished();
}

#[tokio::test]
async fn gemini_manual_refresh_rereads_a_logout_and_keeps_the_http_interval() {
    let cache = UsageCache::default();
    let source = Fixture::new(vec![load(Ok(json!({}))), (FETCH_MODELS, json!({}), Ok(default_models()))]);
    cache.fetch_with(&source, before_expiry, false).await;
    assert_eq!(cache.fetch_with(&source, before_expiry, true).await.state, UsageRowState::Ok);
    assert_eq!(source.reads.load(Ordering::Relaxed), 2);
    let signed_out = Fixture { credentials: Err(UsageError::NotSignedIn), ..Fixture::new(vec![]) };
    let row = cache.fetch_with(&signed_out, before_expiry, true).await;
    assert_eq!(row.error_code.as_deref(), Some("usage.error.gemini_not_signed_in"));
    assert!(row.model_windows.is_empty());
    assert!(row.email.is_none());
    cache.fetch_with(&source, before_expiry, true).await;
    assert_eq!(source.posts.load(Ordering::Relaxed), 2);
    source.assert_finished();
}
