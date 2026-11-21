use super::{
    next_429_backoff_ms, NamedWindow, ProfileUsage, UsageProvider, UsageRowState, WindowStat,
    ERROR_DEFERRED, ERROR_RATE_LIMITED, USAGE_CACHE_TTL_MS,
};
use chrono::{DateTime, FixedOffset, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::Mutex as SnapshotMutex;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const LOAD_PROJECT: &str = "loadCodeAssist";
const FETCH_MODELS: &str = "fetchAvailableModels";
const CACHE_TTL: Duration = Duration::from_millis(USAGE_CACHE_TTL_MS as u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UsageError {
    Expired,
    NotSignedIn,
    ReadCredentials,
    Unsupported,
    Fetch,
    NoUsage,
    RateLimited,
}

impl UsageError {
    fn row(self, email: Option<String>, now: DateTime<Utc>) -> ProfileUsage {
        let (state, code) = match self {
            Self::Expired => (UsageRowState::WaitForCli, "usage.error.gemini_expired"),
            Self::NotSignedIn => (
                UsageRowState::NeedsRelogin,
                "usage.error.gemini_not_signed_in",
            ),
            Self::ReadCredentials => (UsageRowState::Error, "usage.error.gemini_credentials"),
            Self::Unsupported => (UsageRowState::Unsupported, "usage.error.gemini_unsupported"),
            Self::Fetch => (UsageRowState::Error, "usage.error.gemini_fetch"),
            Self::NoUsage => (UsageRowState::Error, "usage.error.gemini_no_usage"),
            Self::RateLimited => (UsageRowState::Cooldown, ERROR_RATE_LIMITED),
        };
        let mut row = usage_row(email, now);
        row.state = state;
        row.error_code = Some(code.into());
        row
    }
}

#[derive(Deserialize)]
pub(crate) struct Credentials {
    token: AccessToken,
    id_token_email: Option<String>,
}

#[derive(Deserialize)]
struct AccessToken {
    access_token: String,
    expiry: DateTime<FixedOffset>,
}

#[cfg(any(windows, test))]
pub(crate) fn parse_credentials(blob: &[u8]) -> Result<Credentials, UsageError> {
    let credentials: Credentials =
        serde_json::from_slice(blob).map_err(|_| UsageError::ReadCredentials)?;
    if credentials.token.access_token.trim().is_empty() {
        return Err(UsageError::ReadCredentials);
    }
    Ok(credentials)
}

#[cfg(windows)]
fn read_credentials() -> Result<Credentials, UsageError> {
    use windows::core::{w, HRESULT};
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    // CredReadW owns the allocation until CredFree. Parse only the fields
    // needed for this read and never retain the raw credential or refresh token.
    struct Credential(*mut CREDENTIALW);
    impl Drop for Credential {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CredFree(self.0.cast()) };
            }
        }
    }
    let mut credential = Credential(std::ptr::null_mut());
    unsafe {
        CredReadW(
            w!("gemini:antigravity"),
            CRED_TYPE_GENERIC,
            0,
            &mut credential.0,
        )
    }
    .map_err(|error| {
        if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) {
            UsageError::NotSignedIn
        } else {
            UsageError::ReadCredentials
        }
    })?;
    let value = unsafe { credential.0.as_ref() }.ok_or(UsageError::ReadCredentials)?;
    if value.CredentialBlob.is_null() || value.CredentialBlobSize == 0 {
        return Err(UsageError::ReadCredentials);
    }
    let blob = unsafe {
        std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize)
    };
    parse_credentials(blob)
}

#[cfg(not(windows))]
fn read_credentials() -> Result<Credentials, UsageError> {
    Err(UsageError::Unsupported)
}

pub(crate) trait Source {
    fn now(&self) -> DateTime<Utc> { Utc::now() }

    fn credentials(&self) -> Result<Credentials, UsageError>;

    fn post(
        &self,
        method: &'static str,
        token: &str,
        body: Value,
    ) -> impl Future<Output = Result<Value, UsageError>> + Send;
}

pub(crate) struct Antigravity;

impl Source for Antigravity {
    fn credentials(&self) -> Result<Credentials, UsageError> {
        read_credentials()
    }

    async fn post(
        &self,
        method: &'static str,
        token: &str,
        body: Value,
    ) -> Result<Value, UsageError> {
        static HTTP: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
        let client = HTTP
            .get_or_init(|| {
                reqwest::Client::builder()
                    .timeout(Duration::from_secs(5))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .ok()
            })
            .as_ref()
            .ok_or(UsageError::Fetch)?;
        let response = client
            .post(format!(
                "https://cloudcode-pa.googleapis.com/v1internal:{method}"
            ))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|_| UsageError::Fetch)?;
        if !response.status().is_success() {
            return Err(http_error(response.status()));
        }
        response.json().await.map_err(|_| UsageError::Fetch)
    }
}

fn http_error(status: reqwest::StatusCode) -> UsageError {
    match status {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => UsageError::Expired,
        reqwest::StatusCode::TOO_MANY_REQUESTS => UsageError::RateLimited,
        _ => UsageError::Fetch,
    }
}

fn project_id(loaded: &Value) -> Option<&str> {
    let project = loaded.get("cloudaicompanionProject")?;
    project
        .as_str()
        .or_else(|| project.get("id")?.as_str())
        .filter(|id| !id.trim().is_empty())
}

fn check_expiry(expiry: DateTime<FixedOffset>, now: DateTime<Utc>) -> Result<(), UsageError> {
    if expiry <= now { Err(UsageError::Expired) } else { Ok(()) }
}

async fn fetch_windows(
    source: &impl Source,
    token: &AccessToken,
    now: &impl Fn() -> DateTime<Utc>,
) -> Result<Vec<NamedWindow>, UsageError> {
    check_expiry(token.expiry, now())?;
    let body = match source
        .post(
            LOAD_PROJECT,
            &token.access_token,
            json!({"metadata": {"ideType": "ANTIGRAVITY"}}),
        )
        .await
    {
        Ok(loaded) => project_id(&loaded).map_or_else(|| json!({}), |id| json!({"project": id})),
        Err(error @ (UsageError::Expired | UsageError::RateLimited)) => return Err(error),
        Err(_) => json!({}),
    };
    check_expiry(token.expiry, now())?;
    parse_windows(&source.post(FETCH_MODELS, &token.access_token, body).await?)
}

fn model_group(id: &str) -> Option<usize> {
    if id.starts_with("tab_") || id.starts_with("chat_") {
        None
    } else if id.starts_with("claude-") {
        Some(2)
    } else if id.contains("flash") {
        Some(1)
    } else if id.starts_with("gemini-4-")
        || id.starts_with("gemini-pro-orchestrator")
        || id == "gemini-2.5-pro"
    {
        Some(0)
    } else {
        None
    }
}

fn parse_windows(response: &Value) -> Result<Vec<NamedWindow>, UsageError> {
    let models = response
        .get("models")
        .and_then(Value::as_object)
        .ok_or(UsageError::Fetch)?;
    let mut groups: [Option<(f64, Option<DateTime<Utc>>)>; 3] = [None; 3];
    for (id, model) in models {
        let Some(group) = model_group(id) else {
            continue;
        };
        let quota = &model["quotaInfo"];
        let Some(remaining) = quota["remainingFraction"]
            .as_f64()
            .filter(|f| (0.0..=1.0).contains(f))
        else {
            continue;
        };
        let reset = quota["resetTime"]
            .as_str()
            .and_then(|time| DateTime::parse_from_rfc3339(time).ok())
            .map(|time| time.with_timezone(&Utc));
        let selected = &mut groups[group];
        // Equally constrained models may reset at different times. Use the
        // latest known reset for those models, when all known limits reset.
        if selected.is_none_or(|(previous, previous_reset)| {
            remaining < previous || (remaining == previous && reset > previous_reset)
        }) {
            *selected = Some((remaining, reset));
        }
    }
    let windows: Vec<_> = ["Pro", "Flash", "Claude"]
        .into_iter()
        .zip(groups)
        .filter_map(|(label, group)| {
            let (remaining, reset) = group?;
            Some(NamedWindow {
                key: label.into(),
                window: WindowStat {
                    pct: (1.0 - remaining) * 100.0,
                    resets_at: reset.map(|time| time.to_rfc3339()).unwrap_or_default(),
                },
            })
        })
        .collect();
    if windows.is_empty() {
        return Err(UsageError::NoUsage);
    }
    Ok(windows)
}

fn usage_row(email: Option<String>, now: DateTime<Utc>) -> ProfileUsage {
    ProfileUsage {
        profile_id: "live:gemini".into(),
        provider: UsageProvider::Gemini,
        label: "Gemini".into(),
        email,
        plan: None,
        subscription: None,
        registered: false,
        is_active: false,
        needs_relogin: false,
        state: UsageRowState::Ok,
        five_hour: None,
        seven_day: None,
        seven_day_sonnet: None,
        seven_day_opus: None,
        model_windows: Vec::new(),
        reset_tickets: None,
        error_code: None,
        token_owner_email: None,
        retry_at: None,
        fetched_at: now.to_rfc3339(),
    }
}

fn waiting_row(email: Option<String>, now: DateTime<Utc>, retry_at: Option<DateTime<Utc>>) -> ProfileUsage {
    if let Some(retry_at) = retry_at {
        let mut row = UsageError::RateLimited.row(email, now);
        row.retry_at = Some(retry_at.to_rfc3339());
        row
    } else {
        let mut row = usage_row(email, now);
        row.state = UsageRowState::Cooldown;
        row.error_code = Some(ERROR_DEFERRED.into());
        row
    }
}

pub(crate) fn unsupported_row(now: DateTime<Utc>) -> ProfileUsage {
    UsageError::Unsupported.row(None, now)
}

#[derive(Clone)]
pub(crate) struct UsageSnapshot {
    revision: u64,
    row: ProfileUsage,
    expiry: Option<DateTime<FixedOffset>>,
    fresh_until: Instant,
}

impl UsageSnapshot {
    pub(crate) fn report_at(self, now: DateTime<Utc>) -> (u64, ProfileUsage) {
        // Expiry advances the report revision within the same snapshot. A
        // delayed report of its quota must not overwrite that expired row.
        let revision = self.revision * 2;
        if self.expiry.is_some_and(|expiry| expiry <= now) {
            (revision + 1, UsageError::Expired.row(self.row.email, now))
        } else {
            (revision, self.row)
        }
    }
}

#[derive(Default)]
struct FetchSchedule {
    next_request_at: Option<Instant>,
    backoff_ms: Option<i64>,
    // Only a current HTTP 429 wait has a resume time in the report.
    retry_at: Option<DateTime<Utc>>,
}

impl FetchSchedule {
    fn finish(&mut self, result: &Result<Vec<NamedWindow>, UsageError>, now: DateTime<Utc>) -> Instant {
        self.retry_at = None;
        let delay = match result {
            Err(UsageError::RateLimited) => {
                let backoff = next_429_backoff_ms(self.backoff_ms);
                self.backoff_ms = Some(backoff);
                self.retry_at = Some(now + chrono::TimeDelta::milliseconds(backoff));
                Duration::from_millis(backoff as u64)
            }
            result => {
                if result.is_ok() { self.backoff_ms = None; }
                CACHE_TTL
            }
        };
        let next_request_at = Instant::now() + delay;
        self.next_request_at = Some(next_request_at);
        next_request_at
    }
}

#[derive(Default)]
pub(crate) struct UsageCache {
    schedule: Mutex<FetchSchedule>,
    // A switch can read the last completed report while a poll is awaiting IO.
    latest: SnapshotMutex<Option<UsageSnapshot>>,
}

impl UsageCache {
    pub(crate) fn snapshot(&self) -> Option<UsageSnapshot> {
        self.latest.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    fn remember(
        &self, row: ProfileUsage, expiry: Option<DateTime<FixedOffset>>, fresh_until: Instant,
    ) -> UsageSnapshot {
        let mut latest = self.latest.lock().unwrap_or_else(|error| error.into_inner());
        let snapshot = UsageSnapshot {
            revision: latest.as_ref().map_or(1, |entry| entry.revision + 1),
            row, expiry, fresh_until,
        };
        *latest = Some(snapshot.clone());
        snapshot
    }

    pub(crate) async fn fetch_snapshot_with(
        &self,
        source: &impl Source,
        now: impl Fn() -> DateTime<Utc>,
        explicit: bool,
    ) -> UsageSnapshot {
        let mut schedule = self.schedule.lock().await;
        let cached = self.snapshot();
        if !explicit {
            if let Some(entry) = cached.as_ref().filter(|entry| Instant::now() < entry.fresh_until) {
                return entry.clone();
            }
        }

        let credentials = match source.credentials() {
            Ok(credentials) => credentials,
            Err(error) => return self.remember(error.row(None, now()), None, Instant::now() + CACHE_TTL),
        };
        let expiry = credentials.token.expiry;
        let email = credentials.id_token_email.filter(|email| !email.trim().is_empty());
        let current = now();
        if check_expiry(expiry, current).is_err() {
            return self.remember(UsageError::Expired.row(email, current), Some(expiry), Instant::now() + CACHE_TTL);
        }

        if let Some(next_request_at) = schedule.next_request_at.filter(|next| Instant::now() < *next) {
            if let Some(entry) = cached.filter(|entry| entry.expiry == Some(expiry) && entry.row.email == email) {
                return entry;
            }
            // The new login has no quota yet and is waiting for its next request.
            return self.remember(waiting_row(email, current, schedule.retry_at), Some(expiry), next_request_at);
        }

        // Reserve the minimum interval even if the caller drops this future.
        schedule.next_request_at = Some(Instant::now() + CACHE_TTL);
        schedule.retry_at = None;
        let result = fetch_windows(source, &credentials.token, &now).await;
        let current = now();
        let fresh_until = schedule.finish(&result, current);
        let row = match check_expiry(expiry, current).and(result) {
            Ok(windows) => {
                let mut row = usage_row(email, current);
                row.model_windows = windows;
                row
            }
            Err(UsageError::RateLimited) => waiting_row(email, current, schedule.retry_at),
            Err(error) => error.row(email, current),
        };
        self.remember(row, Some(expiry), fresh_until)
    }
}

#[cfg(test)]
#[path = "oauth_gemini_tests.rs"]
mod tests;
